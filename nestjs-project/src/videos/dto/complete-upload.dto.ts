import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  eTag: string;
}

export class CompleteUploadDto {
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  @ArrayMinSize(1)
  parts: UploadedPartDto[];
}
