import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden h-5 rounded-sm border px-1.5 font-medium text-xs whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-3",
  {
    variants: {
      // State badges: soft fill, border and text in one state colour (design/DESIGN.md).
      variant: {
        default: "border-(--accent-edge) bg-primary text-primary-foreground",
        secondary: "border-(--idle-border) bg-(--idle-soft) text-(--idle)",
        outline: "border-input text-foreground",
        destructive: "border-(--risk-border) bg-(--risk-soft) text-(--risk)",
        attention: "border-(--attn-border) bg-(--attn-soft) text-(--attn)",
        success: "border-(--ok-border) bg-(--ok-soft) text-(--ok)",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
