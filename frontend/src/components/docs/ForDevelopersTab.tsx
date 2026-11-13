import Link from "next/link";
import { useTranslations } from "next-intl";
import DevlogEntryCard from "@/components/devlog/DevlogEntryCard";
import type { DevlogMeta, DocMeta } from "@/lib/content";

interface ForDevelopersTabProps {
  docs: DocMeta[];
  latest: DevlogMeta[];
}

export default function ForDevelopersTab({
  docs,
  latest,
}: ForDevelopersTabProps) {
  const t = useTranslations("Home");

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-1 lg:grid-cols-2 gap-4">
        {docs.map((doc) => (
          <Link
            key={doc.slug}
            href={`/docs/${doc.slug}`}
            className="p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition"
          >
            <div className="font-semibold">{doc.title}</div>
          </Link>
        ))}
      </div>
      <section className="flex flex-col gap-3">
        <h3 className="font-semibold">{t("docs.devlog.title")}</h3>
        {latest.length === 0 ? (
          <p className="text-sm text-foreground/70">{t("docs.devlog.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {latest.map((entry) => (
              <DevlogEntryCard key={entry.slug} entry={entry} />
            ))}
          </div>
        )}
        <Link href="/devlog" className="hover:underline text-[#ff617b]">
          {t("docs.devlog.all")}
        </Link>
      </section>
      <div>
        {t("docs.issues.description")}{" "}
        <a
          href="https://github.com/AshenHermit/Wired/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline text-[#ff617b]"
        >
          {t("docs.issues.link")}
        </a>
      </div>
    </>
  );
}
