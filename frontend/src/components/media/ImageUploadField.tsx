"use client";

import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { uploadMedia } from "@/api/services/media";
import { Button } from "@/components/ui/button";
import { mediaSrc } from "./media-url";

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 2 * 1024 * 1024;

export type ImageUploadFieldProps = {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
};

/**
 * Entity-agnostic image picker: file choose or clipboard paste uploads
 * immediately via POST /media and reports the returned URL to the parent.
 * Binding the URL to a room/package/user happens on the parent's save.
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

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
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

  return (
    <div
      className="flex flex-col gap-2"
      tabIndex={0}
      onPaste={onPaste}
      aria-busy={uploading}
    >
      <div className="text-sm font-medium">{t("label")}</div>
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mediaSrc(value)}
          alt=""
          className="size-20 rounded-md object-cover object-center"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          disabled={disabled || uploading}
          onChange={onFileChange}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? <Loader2Icon className="animate-spin" /> : null}
          {uploading ? t("uploading") : t("upload")}
        </Button>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => onChange(null)}
          >
            {t("remove")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
