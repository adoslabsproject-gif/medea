import type { InputHTMLAttributes, ReactNode } from 'react';

export type TextFieldSize = 'sm' | 'md' | 'lg';
export type TextFieldStatus = 'default' | 'error' | 'success';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'prefix'
> {
  label?: string;
  hint?: string;
  errorMessage?: string;
  size?: TextFieldSize;
  status?: TextFieldStatus;
  startSlot?: ReactNode;
  endSlot?: ReactNode;
  fullWidth?: boolean;
}
