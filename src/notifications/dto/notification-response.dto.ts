import { ApiProperty } from '@nestjs/swagger';

export class NotificationItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() channel!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, type: String }) readAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationItemDto] }) items!: NotificationItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() unread!: number;
}

export class UnreadCountDto {
  @ApiProperty() unread!: number;
}

export class NotificationPreferencesDto {
  @ApiProperty() inapp!: boolean;
  @ApiProperty() email!: boolean;
  @ApiProperty() sms!: boolean;
  @ApiProperty() push!: boolean;
}
