import { validateContent } from '../src/lib/content';

async function main(): Promise<void> {
  const issues = await validateContent();

  if (issues.length > 0) {
    throw new Error(`invalid content:\n${issues.join('\n')}`);
  }

  console.log('content ok');
}

void main();
