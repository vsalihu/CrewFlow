import { buildTemplate } from './testdb';

export default async function setup(): Promise<void> {
  await buildTemplate();
}
