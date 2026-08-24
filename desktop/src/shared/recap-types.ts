export interface RecapGenerateRequest {
  messages: string[];
  paneId: string;
  chunkIndex: number;
}

export interface RecapGenerateResponse {
  summary: string;
  error?: string;
}
