"use client";

import Image from "next/image";
import React from "react";

export function ImageBackground() {
  const imageSrc = React.useMemo(() => {
    const count = 3;
    const index = Math.floor(Math.random() * count);
    return `/bg/bg_${index + 1}.jpg`;
  }, []);
  const imgRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (imgRef.current) {
      imgRef.current.style.backgroundImage = `url(${imageSrc})`;
      let bgScroll = 0;
      let targetBgScroll = 0;
      const onScroll = (e: Event) => {
        if (imgRef.current) {
          targetBgScroll = -window.scrollY / 2;
        }
      };
      let isUpdating = true;
      const update = () => {
        if (!isUpdating) return;
        if (imgRef.current) {
          bgScroll = bgScroll + (targetBgScroll - bgScroll) * 0.1;
          imgRef.current.style.backgroundPosition = `center ${bgScroll}px`;
        }

        requestAnimationFrame(() => {
          update();
        });
      };

      update();
      window.addEventListener("scroll", onScroll);
      return () => {
        isUpdating = false;
        window.removeEventListener("scroll", onScroll);
      };
    }
  }, []);

  return (
    <div
      ref={imgRef}
      className="fixed top-0 left-0 w-full h-full object-center -z-10 bg-cover bg-center bg-repeat"
    />
  );
}
