import { Button, DialogTrigger, Icon, Menu, Popover } from '@umami/react-zen';
import type { Key, ReactNode } from 'react';
import { Ellipsis } from '@/components/icons';

export function MenuButton({
  children,
  onAction,
  isDisabled,
  label,
}: {
  children: ReactNode;
  onAction?: (action: string) => void;
  isDisabled?: boolean;
  label: string;
}) {
  const handleAction = (key: Key) => {
    onAction?.(key.toString());
  };

  return (
    <DialogTrigger>
      <Button variant="quiet" isDisabled={isDisabled} aria-label={label}>
        <Icon>
          <Ellipsis />
        </Icon>
      </Button>
      <Popover placement="bottom start">
        <Menu aria-label="menu" onAction={handleAction} style={{ minWidth: '140px' }}>
          {children}
        </Menu>
      </Popover>
    </DialogTrigger>
  );
}
