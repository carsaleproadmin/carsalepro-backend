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
  /**
   * The order this notification is about, when it is about one (DEN-325). The
   * website needs it to pair a card with the card that supersedes it.
   *
   * ONLY `orderId` is lifted out of the payload. The payload itself is never
   * returned: some types carry a live single-use secret — see
   * `SECRET_BEARING_TYPES`.
   */
  @ApiProperty({ nullable: true, type: String }) orderId!: string | null;
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
