import { IsInt, IsMimeType, IsString, Min } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  filename: string;

  @IsMimeType()
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;

  @IsInt()
  @Min(1)
  partCount: number;
}
