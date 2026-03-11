import { IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) perPage: number = 25;
}
export interface PaginationMeta { page: number; perPage: number; total: number; totalPages: number; }
export function successResponse<T>(data: T, meta?: PaginationMeta) { return meta ? { success: true as const, data, meta } : { success: true as const, data }; }
export function errorResponse(code: string, message: string) { return { success: false as const, error: { code, message } }; }
export function paginationMeta(total: number, page: number, perPage: number): PaginationMeta { return { page, perPage, total, totalPages: Math.ceil(total / perPage) }; }
