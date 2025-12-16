import { ImageBackground } from "@/components/layout/ImageBackground";
import { UserProvider } from "@/components/providers/UserProvider";
import Image from "next/image";

export default function BrowserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ImageBackground />
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
