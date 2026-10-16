/** Icon components for status keys from lib/labels.ts (one icon family: lucide). */
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleQuestionMark,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
  WifiOff,
} from 'lucide-preact';
import type { StatusIcon } from '../lib/labels.ts';

export type IconComponent = typeof CircleCheck;

export const STATUS_ICONS: Record<StatusIcon, IconComponent> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  bad: CircleX,
  offline: WifiOff,
  dashed: CircleDashed,
  minus: CircleMinus,
  unknown: CircleQuestionMark,
  info: Info,
  busy: LoaderCircle,
};
