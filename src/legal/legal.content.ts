// Localized legal content for CarSalePro (Privacy Policy + Terms of Use).
// Served as HTML by LegalController. Placeholders in [BRACKETS] must be replaced
// with the real legal entity before store submission.
//
// The app and the App Store / Google Play require a stable, public privacy-policy
// URL. GDPR (Art. 13/14) requires disclosure of controller, purposes, legal basis,
// recipients, retention and data-subject rights. Photo retention is permanent
// ("forever") and is stated explicitly, with the in-app erasure path (DELETE /me).

export type LegalLang = 'de' | 'en' | 'ru';
export type LegalDoc = 'privacy' | 'terms';

export const LEGAL_LANGS: LegalLang[] = ['de', 'en', 'ru'];

const LAST_UPDATED = '2026-06-03';

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export interface LegalContent {
  title: string;
  lastUpdatedLabel: string;
  intro: string;
  sections: LegalSection[];
}

// --- The legal entity, supplied by the client on 2026-08-19 ---
//
// These were `[COMPANY NAME]` / `[COMPANY ADDRESS]` / `[CONTACT EMAIL]` until
// then, interpolated into the controller paragraph and the intro of both
// documents in all three languages. That is a hard store blocker, not a
// cosmetic gap: GDPR Art. 13 requires the controller to be named and German
// §5 DDG requires an Impressum, and a reviewer opening the privacy policy would
// have read a square bracket.
//
// `legal.content.spec.ts` now asserts that no `[` survives in any rendered
// section of either document in any of LEGAL_LANGS, so it cannot ship
// unfilled again. The website carries its OWN copy of the same text in
// `messages/{de,en,ru}.json` and had the same placeholders — pointing the app at
// the website would have read a third unfilled copy rather than fixing
// anything.
//
// The entity is a Wyoming LLC, so there is no Registergericht, no register
// number and no USt-IdNr. to quote — the Imprint states the three fields below
// and nothing more (FE-J1 / DEN-37). Keep them in step with
// `carsalepro-frontend/messages/{ru,en,de}.json` -> `legal.imprint`, which is
// the website's own copy of the same text.
// EMAIL became the company's own domain on 2026-09-02, on the client's
// instruction. The mailbox is real: carsalepro.net publishes Cloudflare Email
// Routing MX records and an SPF record.
const COMPANY = 'CarSalePro LLC';
const ADDRESS = '1023 E Lincolnway, Cheyenne, WY 82001, USA';
const EMAIL = 'support@carsalepro.net';

const PRIVACY: Record<LegalLang, LegalContent> = {
  en: {
    title: 'Privacy Policy — CarSalePro',
    lastUpdatedLabel: 'Last updated',
    intro:
      `This Privacy Policy explains how ${COMPANY} ("we", "us") processes personal data in the ` +
      'CarSalePro mobile application for professional vehicle inspection. CarSalePro works offline-first ' +
      'and does not require an account.',
    sections: [
      {
        heading: '1. Controller',
        paragraphs: [
          `${COMPANY}, ${ADDRESS}. Contact for data-protection matters: ${EMAIL}.`,
        ],
      },
      {
        heading: '2. Identity model — no account',
        paragraphs: [
          'CarSalePro does not use names, passwords or email logins. On first launch the app generates a ' +
            'random device identifier (UUID v4) that is stored on your device and sent with each request to ' +
            'our backend as the "X-Device-Id" header. Cloud backups and the free/PRO quota are keyed to this ' +
            'identifier only. It is not linked to your real-world identity by us.',
        ],
      },
      {
        heading: '3. What data we process',
        paragraphs: [
          'Inspection content you create: vehicle identification (VIN, make, model, year), photos of the ' +
            'vehicle and its documents, mileage, checklist answers, damage records, cost estimates, condition ' +
            'notes and digital signatures.',
          'Technical data: the device identifier, app version, coarse approximate location used only once on ' +
            'first launch to suggest an interface language, and — if you opt in — crash diagnostics.',
          'Photos may contain metadata (date, GPS) and may incidentally include people or number plates that ' +
            'you choose to capture. You are responsible for the lawful basis of any third-party data in your ' +
            'photos.',
        ],
      },
      {
        heading: '4. Purposes and legal basis',
        paragraphs: [
          'We process this data to provide the inspection tool, generate PDF reports, and back up reports to ' +
            'the cloud at your request (Art. 6(1)(b) GDPR — performance of the service you requested; and ' +
            'Art. 6(1)(f) GDPR — our legitimate interest in providing a reliable tool).',
          'VIN decoding sends the VIN to the U.S. NHTSA vPIC public service to retrieve vehicle ' +
            'specifications.',
        ],
      },
      {
        heading: '5. Storage and recipients',
        paragraphs: [
          'Inspection data is stored locally on your device. When you back up a report, the PDF is uploaded ' +
            'to object storage operated by Cloudflare R2. PRO subscriptions are validated through Apple App ' +
            'Store or Google Play. Optional crash diagnostics may be sent to Sentry. We do not sell your data.',
        ],
      },
      {
        heading: '6. Retention — photos are kept permanently',
        paragraphs: [
          'Reports and their photos that you back up to the cloud are retained PERMANENTLY ("forever") so they ' +
            'remain available as professional records, unless you delete them. Local data remains until you ' +
            'remove it or uninstall the app.',
          'You can erase all of your cloud data at any time from inside the app ("Delete my data"), which ' +
            'permanently removes every report and object stored for your device identifier.',
        ],
      },
      {
        heading: '7. Your rights',
        paragraphs: [
          'Under the GDPR you have the right to access, rectification, erasure, restriction, portability and ' +
            `objection. The in-app "Delete my data" action exercises your right to erasure. For other requests ` +
            `contact ${EMAIL}. You may also lodge a complaint with a supervisory authority.`,
        ],
      },
      {
        heading: '8. Children',
        paragraphs: ['CarSalePro is a professional tool and is not directed to children.'],
      },
      {
        heading: '9. Changes',
        paragraphs: [
          'We may update this policy. Material changes will be reflected by the "Last updated" date above.',
        ],
      },
    ],
  },
  de: {
    title: 'Datenschutzerklärung — CarSalePro',
    lastUpdatedLabel: 'Zuletzt aktualisiert',
    intro:
      `Diese Datenschutzerklärung erläutert, wie ${COMPANY} ("wir") personenbezogene Daten in der ` +
      'CarSalePro-App zur professionellen Fahrzeugbegutachtung verarbeitet. CarSalePro funktioniert ' +
      'offline-first und benötigt kein Benutzerkonto.',
    sections: [
      {
        heading: '1. Verantwortlicher',
        paragraphs: [`${COMPANY}, ${ADDRESS}. Kontakt in Datenschutzfragen: ${EMAIL}.`],
      },
      {
        heading: '2. Identitätsmodell — kein Konto',
        paragraphs: [
          'CarSalePro verwendet keine Namen, Passwörter oder E-Mail-Logins. Beim ersten Start erzeugt die App ' +
            'eine zufällige Gerätekennung (UUID v4), die auf Ihrem Gerät gespeichert und bei jeder Anfrage als ' +
            '"X-Device-Id"-Header an unser Backend gesendet wird. Cloud-Backups und das Free/PRO-Kontingent sind ' +
            'ausschließlich an diese Kennung gebunden und werden von uns nicht mit Ihrer realen Identität ' +
            'verknüpft.',
        ],
      },
      {
        heading: '3. Welche Daten wir verarbeiten',
        paragraphs: [
          'Begutachtungsinhalte: Fahrzeugidentifikation (FIN, Hersteller, Modell, Jahr), Fotos des Fahrzeugs ' +
            'und seiner Dokumente, Kilometerstand, Checklisten-Antworten, Schadenserfassung, Kostenschätzungen, ' +
            'Zustandsnotizen und digitale Unterschriften.',
          'Technische Daten: die Gerätekennung, App-Version, eine grobe Standortangabe, die nur einmal beim ' +
            'ersten Start zur Sprachvorschlag genutzt wird, und — sofern Sie zustimmen — Absturzdiagnosen.',
          'Fotos können Metadaten (Datum, GPS) enthalten und ggf. Personen oder Kennzeichen abbilden. Für die ' +
            'Rechtsgrundlage abgebildeter Dritter sind Sie verantwortlich.',
        ],
      },
      {
        heading: '4. Zwecke und Rechtsgrundlagen',
        paragraphs: [
          'Wir verarbeiten diese Daten, um das Begutachtungswerkzeug bereitzustellen, PDF-Berichte zu erstellen ' +
            'und Berichte auf Ihren Wunsch in der Cloud zu sichern (Art. 6 Abs. 1 lit. b DSGVO — Erbringung der ' +
            'gewünschten Leistung; Art. 6 Abs. 1 lit. f DSGVO — berechtigtes Interesse an einem zuverlässigen ' +
            'Werkzeug).',
          'Die FIN-Decodierung übermittelt die FIN an den öffentlichen NHTSA-vPIC-Dienst der USA.',
        ],
      },
      {
        heading: '5. Speicherung und Empfänger',
        paragraphs: [
          'Begutachtungsdaten werden lokal auf Ihrem Gerät gespeichert. Beim Backup wird das PDF in den ' +
            'Objektspeicher von Cloudflare R2 hochgeladen. PRO-Abonnements werden über Apple App Store oder ' +
            'Google Play validiert. Optionale Absturzdiagnosen können an Sentry gesendet werden. Wir verkaufen ' +
            'Ihre Daten nicht.',
        ],
      },
      {
        heading: '6. Aufbewahrung — Fotos werden dauerhaft gespeichert',
        paragraphs: [
          'In die Cloud gesicherte Berichte und ihre Fotos werden DAUERHAFT ("für immer") aufbewahrt, damit sie ' +
            'als fachliche Nachweise verfügbar bleiben, sofern Sie sie nicht löschen. Lokale Daten bleiben bis ' +
            'zur Löschung oder Deinstallation erhalten.',
          'Sie können alle Ihre Cloud-Daten jederzeit in der App löschen ("Meine Daten löschen"); dabei werden ' +
            'sämtliche Berichte und Objekte Ihrer Gerätekennung dauerhaft entfernt.',
        ],
      },
      {
        heading: '7. Ihre Rechte',
        paragraphs: [
          'Nach der DSGVO haben Sie das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, ' +
            'Datenübertragbarkeit und Widerspruch. Die Funktion "Meine Daten löschen" setzt Ihr Recht auf ' +
            `Löschung um. Für weitere Anliegen wenden Sie sich an ${EMAIL}. Sie können sich zudem bei einer ` +
            'Aufsichtsbehörde beschweren.',
        ],
      },
      {
        heading: '8. Kinder',
        paragraphs: ['CarSalePro ist ein Fachwerkzeug und richtet sich nicht an Kinder.'],
      },
      {
        heading: '9. Änderungen',
        paragraphs: [
          'Wir können diese Erklärung aktualisieren. Wesentliche Änderungen erkennen Sie am Datum oben.',
        ],
      },
    ],
  },
  ru: {
    title: 'Политика конфиденциальности — CarSalePro',
    lastUpdatedLabel: 'Последнее обновление',
    intro:
      `Настоящая Политика описывает, как ${COMPANY} ("мы") обрабатывает персональные данные в ` +
      'приложении CarSalePro для профессиональной оценки автомобилей. CarSalePro работает офлайн и не ' +
      'требует учётной записи.',
    sections: [
      {
        heading: '1. Оператор данных',
        paragraphs: [`${COMPANY}, ${ADDRESS}. Контакт по вопросам защиты данных: ${EMAIL}.`],
      },
      {
        heading: '2. Модель идентификации — без аккаунта',
        paragraphs: [
          'CarSalePro не использует имена, пароли или вход по email. При первом запуске приложение создаёт ' +
            'случайный идентификатор устройства (UUID v4), который хранится на устройстве и передаётся в каждом ' +
            'запросе к нашему серверу в заголовке "X-Device-Id". Облачные копии и лимит Free/PRO привязаны ' +
            'только к этому идентификатору и не связываются нами с вашей реальной личностью.',
        ],
      },
      {
        heading: '3. Какие данные мы обрабатываем',
        paragraphs: [
          'Содержимое осмотра: идентификация автомобиля (VIN, марка, модель, год), фотографии автомобиля и ' +
            'документов, пробег, ответы чек-листа, записи о повреждениях, сметы, заметки о состоянии и ' +
            'электронные подписи.',
          'Технические данные: идентификатор устройства, версия приложения, приблизительное местоположение, ' +
            'используемое однократно при первом запуске для выбора языка, и — при вашем согласии — диагностика ' +
            'сбоев.',
          'Фотографии могут содержать метаданные (дата, GPS) и случайно изображать людей или номерные знаки. ' +
            'За правовое основание данных третьих лиц на ваших фото отвечаете вы.',
        ],
      },
      {
        heading: '4. Цели и правовое основание',
        paragraphs: [
          'Мы обрабатываем данные, чтобы предоставлять инструмент осмотра, формировать PDF-отчёты и создавать ' +
            'облачные копии по вашему запросу (ст. 6(1)(b) GDPR — исполнение запрошенной услуги; ст. 6(1)(f) ' +
            'GDPR — законный интерес в надёжном инструменте).',
          'Декодирование VIN отправляет VIN в публичный сервис NHTSA vPIC (США).',
        ],
      },
      {
        heading: '5. Хранение и получатели',
        paragraphs: [
          'Данные осмотра хранятся локально на вашем устройстве. При создании копии PDF загружается в ' +
            'объектное хранилище Cloudflare R2. Подписки PRO проверяются через Apple App Store или Google Play. ' +
            'Необязательная диагностика сбоев может отправляться в Sentry. Мы не продаём ваши данные.',
        ],
      },
      {
        heading: '6. Срок хранения — фотографии хранятся постоянно',
        paragraphs: [
          'Загруженные в облако отчёты и их фотографии хранятся ПОСТОЯННО ("навсегда"), чтобы оставаться ' +
            'доступными как профессиональные документы, пока вы их не удалите. Локальные данные хранятся до ' +
            'удаления или деинсталляции приложения.',
          'Вы можете удалить все облачные данные в любой момент в приложении ("Удалить мои данные"); это ' +
            'безвозвратно удаляет все отчёты и объекты вашего идентификатора устройства.',
        ],
      },
      {
        heading: '7. Ваши права',
        paragraphs: [
          'По GDPR вы имеете право на доступ, исправление, удаление, ограничение, переносимость и возражение. ' +
            'Функция "Удалить мои данные" реализует право на удаление. По другим запросам обращайтесь на ' +
            `${EMAIL}. Вы также можете подать жалобу в надзорный орган.`,
        ],
      },
      {
        heading: '8. Дети',
        paragraphs: ['CarSalePro — профессиональный инструмент и не предназначен для детей.'],
      },
      {
        heading: '9. Изменения',
        paragraphs: [
          'Мы можем обновлять эту Политику. Существенные изменения отражаются в дате обновления выше.',
        ],
      },
    ],
  },
};

const TERMS: Record<LegalLang, LegalContent> = {
  en: {
    title: 'Terms of Use — CarSalePro',
    lastUpdatedLabel: 'Last updated',
    intro:
      `These Terms govern your use of the CarSalePro application provided by ${COMPANY}. By using the app ` +
      'you agree to these Terms.',
    sections: [
      {
        heading: '1. The service',
        paragraphs: [
          'CarSalePro is a tool that helps professional appraisers document vehicle inspections and produce ' +
            'PDF reports. It works offline and optionally backs up reports to the cloud.',
        ],
      },
      {
        heading: '2. Free and PRO',
        paragraphs: [
          'The free tier allows a limited number of cloud-backed reports. A PRO subscription, purchased through ' +
            'Apple App Store or Google Play, removes that limit and enables PRO features. Subscriptions renew and ' +
            'can be managed or cancelled in your store account, subject to the store’s rules.',
        ],
      },
      {
        heading: '3. Your responsibility',
        paragraphs: [
          'You are solely responsible for the accuracy and lawful use of the inspection content you create, ' +
            'including any third-party personal data captured in photos. Reports reflect your professional ' +
            'assessment, not ours.',
        ],
      },
      {
        heading: '4. Disclaimer',
        paragraphs: [
          'The app is provided "as is" without warranties to the extent permitted by law. We are not liable ' +
            'for inspection conclusions, valuations, or decisions based on reports you generate.',
        ],
      },
      {
        heading: '5. Data',
        paragraphs: [
          'Processing of personal data is described in the Privacy Policy.',
        ],
      },
      {
        heading: '6. Changes',
        paragraphs: ['We may update these Terms; the "Last updated" date reflects the current version.'],
      },
    ],
  },
  de: {
    title: 'Nutzungsbedingungen — CarSalePro',
    lastUpdatedLabel: 'Zuletzt aktualisiert',
    intro:
      `Diese Bedingungen regeln Ihre Nutzung der von ${COMPANY} bereitgestellten App CarSalePro. Mit der ` +
      'Nutzung stimmen Sie diesen Bedingungen zu.',
    sections: [
      {
        heading: '1. Der Dienst',
        paragraphs: [
          'CarSalePro unterstützt professionelle Gutachter bei der Dokumentation von Fahrzeugbegutachtungen ' +
            'und der Erstellung von PDF-Berichten. Es funktioniert offline und sichert Berichte optional in der ' +
            'Cloud.',
        ],
      },
      {
        heading: '2. Free und PRO',
        paragraphs: [
          'Die kostenlose Stufe erlaubt eine begrenzte Anzahl cloud-gesicherter Berichte. Ein PRO-Abonnement, ' +
            'erworben über Apple App Store oder Google Play, hebt dieses Limit auf und schaltet PRO-Funktionen ' +
            'frei. Abonnements verlängern sich und können in Ihrem Store-Konto verwaltet oder gekündigt werden.',
        ],
      },
      {
        heading: '3. Ihre Verantwortung',
        paragraphs: [
          'Sie sind allein verantwortlich für die Richtigkeit und rechtmäßige Nutzung der von Ihnen erstellten ' +
            'Inhalte, einschließlich personenbezogener Daten Dritter auf Fotos. Berichte spiegeln Ihre fachliche ' +
            'Einschätzung wider, nicht unsere.',
        ],
      },
      {
        heading: '4. Haftungsausschluss',
        paragraphs: [
          'Die App wird im gesetzlich zulässigen Rahmen "wie besehen" ohne Gewährleistung bereitgestellt. Wir ' +
            'haften nicht für Begutachtungsergebnisse, Bewertungen oder Entscheidungen auf Basis Ihrer Berichte.',
        ],
      },
      {
        heading: '5. Daten',
        paragraphs: ['Die Verarbeitung personenbezogener Daten ist in der Datenschutzerklärung beschrieben.'],
      },
      {
        heading: '6. Änderungen',
        paragraphs: ['Wir können diese Bedingungen aktualisieren; das Datum oben zeigt die aktuelle Fassung.'],
      },
    ],
  },
  ru: {
    title: 'Условия использования — CarSalePro',
    lastUpdatedLabel: 'Последнее обновление',
    intro:
      `Настоящие Условия регулируют использование приложения CarSalePro, предоставляемого ${COMPANY}. ` +
      'Используя приложение, вы соглашаетесь с этими Условиями.',
    sections: [
      {
        heading: '1. Сервис',
        paragraphs: [
          'CarSalePro помогает профессиональным оценщикам документировать осмотр автомобилей и формировать ' +
            'PDF-отчёты. Работает офлайн и по желанию создаёт облачные копии отчётов.',
        ],
      },
      {
        heading: '2. Free и PRO',
        paragraphs: [
          'Бесплатный тариф позволяет ограниченное число облачных копий отчётов. Подписка PRO, приобретаемая ' +
            'через Apple App Store или Google Play, снимает ограничение и открывает функции PRO. Подписки ' +
            'продлеваются и управляются в вашем магазинном аккаунте.',
        ],
      },
      {
        heading: '3. Ваша ответственность',
        paragraphs: [
          'Вы несёте полную ответственность за точность и законность создаваемого контента осмотра, включая ' +
            'персональные данные третьих лиц на фотографиях. Отчёты отражают вашу профессиональную оценку, не ' +
            'нашу.',
        ],
      },
      {
        heading: '4. Отказ от гарантий',
        paragraphs: [
          'Приложение предоставляется "как есть" без гарантий в пределах, допустимых законом. Мы не несём ' +
            'ответственности за выводы осмотра, оценки или решения, принятые на основе ваших отчётов.',
        ],
      },
      {
        heading: '5. Данные',
        paragraphs: ['Обработка персональных данных описана в Политике конфиденциальности.'],
      },
      {
        heading: '6. Изменения',
        paragraphs: ['Мы можем обновлять Условия; дата выше отражает текущую версию.'],
      },
    ],
  },
};

export function getLegalContent(doc: LegalDoc, lang: LegalLang): LegalContent {
  return doc === 'privacy' ? PRIVACY[lang] : TERMS[lang];
}

export function legalLastUpdated(): string {
  return LAST_UPDATED;
}

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

/** Renders a self-contained, calm, mobile-friendly HTML page. */
export function renderLegalHtml(content: LegalContent, lang: LegalLang): string {
  const sections = content.sections
    .map(
      (s) =>
        `<section><h2>${esc(s.heading)}</h2>${s.paragraphs
          .map((p) => `<p>${esc(p)}</p>`)
          .join('')}</section>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="index,follow" />
<title>${esc(content.title)}</title>
<style>
  :root { --ink:#0E1116; --fg2:#3A424C; --fg3:#6B7380; --blue:#1E5FD1; --paper:#FAFBFC; --border:#E4E7EB; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--fg2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    line-height:1.55; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { color:var(--ink); font-size:28px; line-height:1.2; margin:0 0 4px; }
  h2 { color:var(--ink); font-size:18px; margin:28px 0 8px; }
  p { margin:0 0 12px; }
  .updated { color:var(--fg3); font-size:13px; margin-bottom:24px; }
  a { color:var(--blue); }
  hr { border:0; border-top:1px solid var(--border); margin:24px 0; }
</style>
</head>
<body>
<main>
  <h1>${esc(content.title)}</h1>
  <div class="updated">${esc(content.lastUpdatedLabel)}: ${LAST_UPDATED}</div>
  <p>${esc(content.intro)}</p>
  <hr />
  ${sections}
</main>
</body>
</html>`;
}
