export interface EmailAccountRef {
  readonly id: string;
  readonly email: string;
}

export interface EmailMessageSummary {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly preview: string;
  readonly unread: boolean;
}

export interface EmailMessage extends EmailMessageSummary {
  readonly to: string[];
  readonly text: string;
}
