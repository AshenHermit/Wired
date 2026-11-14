import Link from "next/link";
import { useTranslations } from "next-intl";
import type { DevlogMeta } from "@/lib/content";

interface DevlogEntryCardProps {
  entry: DevlogMeta;
}

export default function DevlogEntryCard({ entry }: DevlogEntryCardProps) {
  const t = useTranslations("Devlog");

  return (
    <Link
      href={`/devlog/${entry.slug}`}
      className="block p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition backdrop-blur-sm bg-black/20"
    >
      <article>
        <div className="flex items-center gap-3 text-sm text-foreground/70 mb-2">
          <time dateTime={entry.date}>{entry.date}</time>
          <span
            className="rounded bg-foreground/10 px-2 py-0.5 text-xs"
            title={t("versionLabel")}
          >
            {entry.version}
          </span>
        </div>
        <h3 className="font-semibold mb-1">{entry.title}</h3>
        <p className="text-sm text-foreground/70">{entry.summary}</p>
      </article>
    </Link>
  );
}
