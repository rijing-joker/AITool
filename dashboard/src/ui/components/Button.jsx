import React from "react";
import { cn } from "../../lib/cn";

/**
 * Button - OpenAI 风格的按钮组件
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - 按钮内容
 * @param {'primary'|'secondary'|'ghost'|'danger'} [props.variant='primary'] - 按钮变体
 * @param {'sm'|'md'|'lg'|'icon'} [props.size='md'] - 按钮尺寸
 * @param {function} [props.onClick] - 点击事件处理函数
 * @param {boolean} [props.disabled=false] - 是否禁用
 * @param {string} [props.className] - 额外的 CSS 类名
 * @param {React.ElementType} [props.as] - 渲染的元素类型
 */
export function Button({
  children,
  variant = "primary",
  size = "md",
  onClick,
  disabled = false,
  className = "",
  as: Component = "button",
  ...props
}) {
  const baseStyles =
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 disabled:pointer-events-none";

  const variantStyles = {
    primary:
      "border-transparent bg-oai-brand-700 text-oai-white hover:bg-oai-brand-800 active:bg-oai-brand-900 focus-visible:outline-oai-white focus-visible:outline-offset-[-4px]",
    secondary:
      "border-oai-gray-200 bg-oai-white text-oai-gray-700 hover:border-oai-gray-300 hover:bg-oai-gray-100 active:bg-oai-gray-200 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800 dark:active:bg-oai-gray-700",
    ghost:
      "border-transparent bg-transparent text-oai-gray-600 hover:bg-oai-gray-100 hover:text-oai-black active:bg-oai-gray-200 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-oai-white dark:active:bg-oai-gray-700",
    danger:
      "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 active:bg-red-200 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950 dark:active:bg-red-900",
  };

  const sizeStyles = {
    sm: "h-10 sm:h-9 px-3 text-sm",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
    icon: "h-10 w-10 p-0 text-sm",
  };

  const disabledStyles = disabled
    ? "cursor-not-allowed opacity-60"
    : "cursor-pointer";

  const mergedClassName = cn(baseStyles, variantStyles[variant], sizeStyles[size], disabledStyles, className);

  return (
    <Component
      className={mergedClassName}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </Component>
  );
}
