import type { LocalImage } from '../../content/markdown.js';
import { validateImage } from './imagex.js';

export async function preflightImages(images: LocalImage[], cover?: string): Promise<void> {
  const paths = new Set(images.map(image => image.path));
  if (cover) paths.add(cover);
  for (const path of paths) await validateImage(path);
}
