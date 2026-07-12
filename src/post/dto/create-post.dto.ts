import {
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  IsPositive,
} from 'class-validator';

export class CreatePostDto {
  @IsMongoId()
  artifactId: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  version?: number;

  @IsMongoId()
  connectedAccount: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
