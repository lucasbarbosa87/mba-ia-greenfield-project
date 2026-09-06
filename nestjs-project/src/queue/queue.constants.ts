export const QUEUE_NAMES = {
  VIDEO_PROCESSING: 'video-processing',
} as const;

export const JOB_NAMES = {
  PROCESS_VIDEO: 'process-video',
} as const;

export interface ProcessVideoJobPayload {
  videoId: string;
}
