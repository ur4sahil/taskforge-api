import { IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) perPage: number = 25;
}

export interface PaginationMeta {
  page: number; perPage: number; total: number; totalPages: number;
}

export function successResponse(data: any, meta?: PaginationMeta) {
  return meta ? { success: true, data, meta } : { success: true, data };
}

export function errorResponse(code: string, message: string) {
  return { success: false, error: { code, message } };
}

export function paginationMeta(total: number, page: number, perPage: number): PaginationMeta {
  return { page, perPage, total, totalPages: Math.ceil(total / perPage) };
}
