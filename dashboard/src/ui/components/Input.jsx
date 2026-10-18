import React, { useId } from "react";
import { cn } from "../../lib/cn";

/**
 * Input - OpenAI 风格的输入框组件
 *
 * @param {Object} props
 * @param {string} [props.id] - Optional id; auto-generated via useId when omitted.
 * @param {string} [props.value] - 输入值
 * @param {function} [props.onChange] - 值变化事件处理函数
 * @param {string} [props.placeholder] - 占位符文本
 * @param {boolean} [props.disabled=false] - 是否禁用
 * @param {string} [props.type='text'] - 输入类型
 * @param {string} [props.label] - 标签文本
 * @param {string} [props.error] - 错误信息
 * @param {string} [props.className] - 额外的 CSS 类名
 */
export function Input({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  type = "text",
  label,
  error,
  className = "",
  ...props
}) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const errorId = error ? `${inputId}-error` : undefined;

  const baseStyles =
    "h-10 w-full rounded-lg border border-oai-gray-200 bg-oai-white px-3 text-sm text-oai-black placeholder:text-oai-gray-500 transition-colors duration-150 motion-reduce:transition-none hover:border-oai-gray-300 focus:border-oai-brand-600 focus:ring-2 focus:ring-inset focus:ring-oai-brand-600/20 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white dark:placeholder:text-oai-gray-400 dark:hover:border-oai-gray-600 dark:focus:border-oai-brand-500";

  const disabledStyles = disabled
    ? "bg-oai-gray-50 dark:bg-oai-gray-800 text-oai-gray-400 dark:text-oai-gray-400 cursor-not-allowed"
    : "";

  const errorStyles = error
    ? "border-oai-error focus:border-oai-error focus:ring-oai-error/30 dark:border-oai-error dark:focus:border-oai-error"
    : "";

  const mergedClassName = cn(baseStyles, disabledStyles, errorStyles, className);

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5 transition-colors duration-200"
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={mergedClassName}
        {...props}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-sm text-oai-error">
          {error}
        </p>
      )}
    </div>
  );
}
