import slugify from 'slugify';
import { v4 as uuidv4 } from 'uuid';

export function generateSlug(name: string): string {
  return slugify(name, { lower: true, strict: true }) + '-' + uuidv4().slice(0, 6);
}

export function generateInboundEmail(domain: string): string {
  return uuidv4() + '@' + domain;
}
