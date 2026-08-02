"use client";

import Link from "next/link";
import { usePathname, useParams as useNextParams, useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";

type RouterLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  children: ReactNode;
};

export function useLocation() {
  const pathname = usePathname();
  return { pathname: pathname || "/" };
}

export function useParams() {
  return useNextParams() || {};
}

export function useNavigate() {
  const router = useRouter();
  return (to: string | number) => {
    if (typeof to === "number") {
      if (to < 0) {
        router.back();
      } else {
        router.forward();
      }
      return;
    }
    if (!to) return;
    router.push(to);
  };
}

export function LinkCompat({ to, children, ...rest }: RouterLinkProps) {
  const isExternal = /^https?:\/\//.test(to);

  if (isExternal) {
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <Link href={to} {...rest}>
      {children}
    </Link>
  );
}

export function Navigate({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return null;
}

export function Outlet() {
  return null;
}

export { LinkCompat as Link };
