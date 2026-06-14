import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import {
  ListNotificationsQueryDto,
  UpdatePreferencesDto,
} from './dto/notification-query.dto';
import {
  NotificationListDto,
  NotificationPreferencesDto,
  UnreadCountDto,
} from './dto/notification-response.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List the current user\'s in-app notifications (paginated)' })
  @ApiOkResponse({ type: NotificationListDto })
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListDto> {
    return this.notifications.list(userId, {
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count of unread in-app notifications' })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(@CurrentUser('id') userId: string): Promise<UnreadCountDto> {
    return { unread: await this.notifications.unreadCount(userId) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a single notification read' })
  @ApiParam({ name: 'id' })
  async markRead(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.notifications.markRead(userId, id);
    return { ok: true };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all notifications read' })
  async markAllRead(@CurrentUser('id') userId: string): Promise<{ updated: number }> {
    const updated = await this.notifications.markAllRead(userId);
    return { updated };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get the current user\'s notification preferences' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  getPreferences(
    @CurrentUser('id') userId: string,
  ): Promise<NotificationPreferencesDto> {
    return this.notifications.getPreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification channel preferences' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    return this.notifications.updatePreferences(userId, dto);
  }
}
