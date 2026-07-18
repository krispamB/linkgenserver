import { IsInt, IsMongoId, IsOptional, IsPositive } from 'class-validator';

export class UpdatePostDto {
  @IsMongoId()
  artifactId: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  version?: number;
}
