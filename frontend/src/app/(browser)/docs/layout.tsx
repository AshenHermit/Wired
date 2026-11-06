import Link from "next/link";
import { ReactNode } from "react";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="max-h-screen">
      <Link href={"/"} className="fixed top-0 left-0 px-16">
        <img
          src={"/logo_splash.png"}
          alt="logo"
          className="render-pixelated object-contain h-16"
        />
      </Link>
      {children}
    </div>
  );
}
