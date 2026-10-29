import { Injectable } from '@nestjs/common';
import { PrismaService } from '@ozz/database';
import { getTemplate, listTemplates, previewTemplate } from '@ozz/control-plane/templates';
import { OperationRequestError } from '@ozz/control-plane/tasks';
import { Problem } from '../../common/problem.js';
import type { TemplatePreviewInputDto, TemplateQueryDto } from './template.dto.js';

@Injectable()
export class TemplatesService {
  constructor(private readonly database: PrismaService) {}
  private async request<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OperationRequestError)
        throw new Problem(error.status, error.code, error.message);
      throw error;
    }
  }
  list(query: TemplateQueryDto) {
    return this.request(() => listTemplates(query));
  }
  get(id: string, version?: string) {
    return this.request(() => ({ data: getTemplate(id, version) }));
  }
  preview(id: string, input: TemplatePreviewInputDto) {
    return this.request(async () => ({ data: await previewTemplate(this.database, id, input) }));
  }
}
