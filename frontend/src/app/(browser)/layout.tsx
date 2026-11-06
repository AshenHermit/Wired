import { ImageBackground } from "@/components/layout/ImageBackground";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import Image from "next/image";

export default function BrowserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ImageBackground />
      <LocaleSwitcher className="fixed right-4 top-4 z-20" />
      <div className="windows flex min-h-screen items-center justify-center font-sans">
        {children}
      </div>
    </>
  );
}
