import { validateContent } from '../src/lib/content';

async function main(): Promise<void> {
  const issues = await validateContent();

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(issue);
    }
    process.exit(1);
  }

  console.log('content ok');
}

void main();
