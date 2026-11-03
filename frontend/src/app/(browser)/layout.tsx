import { ImageBackground } from "@/components/layout/ImageBackground";
import { UserProvider } from "@/components/providers/UserProvider";
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
        <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-stretch py-32 px-16">
          <img
            src={"/logo_splash.png"}
            alt="logo"
            className="render-pixelated object-contain w-lg"
          />
          {children}
        </main>
      </div>
    </>
  );
}
