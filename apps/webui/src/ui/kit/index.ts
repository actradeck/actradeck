/**
 * Adaptive Clarity kit — バレル。Carbon を置換するネイティブ駆動・トークン消費の UI プリミティブ。
 * すべて `src/ui/kit/` に置くことで eslint の token-isolation ゲートと browser-graph 走査に自動包含。
 */
export { Icon, type IconName, type IconProps } from "./Icon";
export {
  Button,
  IconButton,
  type ButtonKind,
  type ButtonProps,
  type IconButtonProps,
} from "./Button";
export { Tag, type Tone, type TagProps } from "./Tag";
export { StatusBadge } from "./StatusBadge";
export { Table, THead, TBody, Tr, Th, Td, type TableProps } from "./Table";
export { Card, type CardProps } from "./Card";
export { InlineAlert, type AlertKind, type InlineAlertProps } from "./InlineAlert";
export { Select, type SelectProps } from "./Select";
export { RangeSlider, type RangeSliderProps } from "./RangeSlider";
export { AppHeader, type AppHeaderProps } from "./AppHeader";
export { Modal, type ModalProps } from "./Modal";
