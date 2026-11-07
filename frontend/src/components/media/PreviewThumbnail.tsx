import { mediaSrc } from "./media-url";

export function PreviewThumbnail({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={mediaSrc(src)}
      alt=""
      className={`size-20 shrink-0 rounded-md object-cover object-center ${className ?? ""}`.trim()}
    />
  );
}
