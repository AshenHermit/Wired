import { listDocs, latestDevlog } from '@/lib/content';
import { HomepageClient } from './HomepageClient';

export default async function Home() {
  const [docs, latest] = await Promise.all([listDocs(), latestDevlog(3)]);

  return <HomepageClient docs={docs} latest={latest} />;
}
