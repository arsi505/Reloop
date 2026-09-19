export interface WebhookIngestResponseDto {
  status: 'accepted' | 'ignored_duplicate';
  eventId: string;
  providerEventId: string;
  receivedAt: string;
}
