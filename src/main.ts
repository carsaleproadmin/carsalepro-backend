import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import 'reflect-metadata';
import { AppModule } from './app.module';
import { initSentry } from './common/sentry/sentry.bootstrap';
import { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  // rawBody:true exposes req.rawBody, which the Stripe webhook controller needs
  // for signature verification. The default parsers are disabled and re-added
  // via useBodyParser (rawBody-aware) with a raised JSON limit — structured
  // reportData payloads from the mobile app can exceed Express' 100 kb default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    rawBody: true,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  const sentry = config.get('sentry', { infer: true });

  initSentry(sentry.dsn, sentry.environment, process.env.npm_package_version);

  app.use(
    helmet({
      contentSecurityPolicy: false, // Swagger UI inline scripts
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS. In production, reflect only the configured web origin and Vercel
  // preview deployments (https://*.vercel.app); deny everything else. Requests
  // with no Origin header (server-to-server, e.g. the Stripe webhook, health
  // probes) are always allowed. Outside production we stay permissive for local
  // dev. Bearer-token auth means no cookies, so credentials stay disabled.
  const isProd = config.get('nodeEnv', { infer: true }) === 'production';
  if (isProd) {
    const webOrigin = config.get('web', { infer: true }).origin.replace(/\/$/, '');
    const vercelPreview = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
    app.enableCors({
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        // No Origin header → not a browser CORS request (server-to-server). Allow.
        if (!origin) return callback(null, true);
        if (origin === webOrigin || vercelPreview.test(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: false,
    });
  } else {
    app.enableCors({ origin: true, credentials: false });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: undefined });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CarSalePro Backend')
    .setDescription(
      'Backend for the CarSalePro mobile MVP — VIN decode, cloud backup of inspection PDFs, ' +
        'and per-device quota gating. Identity is the X-Device-Id header (UUID v4).',
    )
    .setVersion(process.env.npm_package_version ?? '0.1.0')
    .addTag('health', 'Liveness + dependency probe')
    .addTag('vin', 'NHTSA vPIC decoder with Postgres cache')
    .addTag('quota', 'FREE-tier reports counter and PRO upgrade')
    .addTag('reports', 'Cloud backup of inspection PDFs')
    .addTag('me', 'Per-device account operations (GDPR erasure)')
    .addTag('legal', 'Privacy Policy and Terms of Use (localized HTML)')
    .addTag('catalog', 'Reference data: inspection angles, parts, damage types, K/S/T codes, checklist')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    jsonDocumentUrl: 'docs-json',
  });

  await app.listen(port, '0.0.0.0');
  Logger.log(`CarSalePro backend listening on :${port} (NODE_ENV=${config.get('nodeEnv', { infer: true })})`, 'Bootstrap');
  Logger.log(`Swagger UI:    http://localhost:${port}/docs`, 'Bootstrap');
  Logger.log(`OpenAPI JSON:  http://localhost:${port}/docs-json`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal during bootstrap:', err);
  process.exit(1);
});
