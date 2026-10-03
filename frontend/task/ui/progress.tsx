"use client";
import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
export function Progress({
  value = 0,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root className="fw-progress" value={value} {...props}>
      <ProgressPrimitive.Indicator
        className="fw-progress-indicator"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
