import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Problem } from './problem';

export class PageQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export interface Cursor {
  id: string;
  createdAt: Date;
}

export function encodeCursor(record: Cursor): string {
  return Buffer.from(JSON.stringify([record.createdAt.toISOString(), record.id])).toString(
    'base64url',
  );
}

export function decodeCursor(value?: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('invalid');
    const [date, id] = parsed as unknown[];
    if (typeof date !== 'string' || typeof id !== 'string') throw new Error('invalid');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error('invalid');
    const createdAt = new Date(date);
    if (Number.isNaN(createdAt.valueOf())) throw new Error('invalid');
    return { id, createdAt };
  } catch {
    throw new Problem(422, 'INVALID_CURSOR', '分页位置无效，请重新加载列表。');
  }
}

/** Query limit + 1 rows ordered by createdAt DESC, id DESC. */
export function pageResult<T extends Cursor>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const data = items.slice(0, limit);
  const last = data.at(-1);
  return { data, page: { nextCursor: hasMore && last ? encodeCursor(last) : null, hasMore } };
}
