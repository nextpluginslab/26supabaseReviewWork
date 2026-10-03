"use client";
import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";
export function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      className={cn("fw-radio-group", className)}
      {...props}
    />
  );
}
export function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn("fw-radio-item", className)}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="fw-radio-indicator" />
    </RadioGroupPrimitive.Item>
  );
}
