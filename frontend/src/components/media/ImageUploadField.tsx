"use client";

import { ImageIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { uploadMedia } from "@/api/services/media";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import { cn } from "@/lib/utils";
import { mediaSrc } from "./media-url";

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 2 * 1024 * 1024;

export type ImageUploadFieldProps = {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
};

/**
 * Entity-agnostic image picker: a square frame opens a menu for file choose,
 * clipboard paste, or remove. Upload happens immediately via POST /media;
 * binding the URL to a room/package/user happens on the parent's save.
 */
export function ImageUploadField({
  value,
  onChange,
  disabled = false,
}: ImageUploadFieldProps) {
  const t = useTranslations("Media");
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = React.useCallback(
    async (file: File) => {
      if (disabled || uploading) return;
      if (!ACCEPTED.has(file.type)) {
        toast.error(t("errors.invalidType"));
        return;
      }
      if (file.size > MAX_BYTES) {
        toast.error(t("errors.tooLarge"));
        return;
      }
      setUploading(true);
      try {
        const result = await uploadMedia(file);
        onChange(result.url);
      } catch (error) {
        console.error(error);
        toast.error(t("errors.uploadFailed"));
      } finally {
        setUploading(false);
      }
    },
    [disabled, onChange, t, uploading],
  );

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void upload(file);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLButtonElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void upload(file);
          return;
        }
      }
    }
    const files = event.clipboardData?.files;
    if (files?.[0]?.type.startsWith("image/")) {
      event.preventDefault();
      void upload(files[0]);
    }
  };

  const pasteFromClipboard = async () => {
    if (disabled || uploading) return;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) =>
          ACCEPTED.has(candidate),
        );
        if (!type) continue;
        const blob = await item.getType(type);
        const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1]!;
        const file = new File([blob], `paste.${extension}`, { type });
        await upload(file);
        return;
      }
      toast.error(t("errors.clipboardFailed"));
    } catch (error) {
      console.error(error);
      toast.error(t("errors.clipboardFailed"));
    }
  };

  const busy = disabled || uploading;

  return (
    <div className="flex flex-col gap-2" aria-busy={uploading}>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        disabled={busy}
        onChange={onFileChange}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={busy}>
          <button
            type="button"
            disabled={busy}
            onPaste={onPaste}
            aria-label={t("label")}
            className={cn(
              "relative flex size-20 items-center justify-center overflow-hidden rounded-md border bg-muted/30 text-muted-foreground outline-none transition-colors",
              "hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {value ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mediaSrc(value)}
                alt=""
                className="size-full object-cover object-center"
              />
            ) : (
              <ImageIcon className="size-6" aria-hidden />
            )}
            {uploading ? (
              <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2Icon className="size-5 animate-spin" aria-hidden />
                <span className="sr-only">{t("uploading")}</span>
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => {
              void pasteFromClipboard();
            }}
          >
            {t("paste")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => {
              inputRef.current?.click();
            }}
          >
            {t("upload")}
          </DropdownMenuItem>
          {value ? (
            <DropdownMenuItem
              disabled={busy}
              variant="destructive"
              onSelect={() => onChange(null)}
            >
              {t("remove")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
