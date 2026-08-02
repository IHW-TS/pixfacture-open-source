"use client";

/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

const ERROR_IMG_SRC =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg==";

export function ImageWithFallback(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [didError, setDidError] = useState(false);
  const { src, alt, style, className, loading, decoding, ...rest } = props;

  const sharedProps = {
    ...rest,
    className,
    style,
    loading: loading || "lazy",
    decoding: decoding || "async",
  };

  if (didError) {
    return (
      <div className={`inline-block bg-gray-100 text-center align-middle ${className ?? ""}`} style={style}>
        <div className="flex items-center justify-center w-full h-full">
          <img src={ERROR_IMG_SRC} alt="Image indisponible" {...sharedProps} data-original-url={src} />
        </div>
      </div>
    );
  }

  return <img src={src} alt={alt || ""} {...sharedProps} onError={() => setDidError(true)} />;
}
