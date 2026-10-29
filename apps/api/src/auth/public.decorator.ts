import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'ozz:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);
