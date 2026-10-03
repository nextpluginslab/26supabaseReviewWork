"use client";
import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";
export function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) { return <RadioGroupPrimitive.Root className={cn("radio-group", className)} {...props} />; }
export function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) { return <RadioGroupPrimitive.Item className={cn("radio-item", className)} {...props}><RadioGroupPrimitive.Indicator className="radio-indicator" /></RadioGroupPrimitive.Item>; }
