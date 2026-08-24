import { ElectronSettingRow } from './ElectronSettingRow';

export function TerminalSettings() {
  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Terminal
      </h3>
      <div className="divide-y divide-[var(--border)]">
        <ElectronSettingRow
          settingKey="cursorStyle"
          label="Cursor Style"
          description="Shape of the terminal cursor"
          type="select"
          options={[
            { value: 'block', label: 'Block' },
            { value: 'underline', label: 'Underline' },
            { value: 'bar', label: 'Bar' },
          ]}
        />
        <ElectronSettingRow
          settingKey="cursorBlink"
          label="Cursor Blink"
          description="Whether the terminal cursor blinks"
          type="boolean"
        />
        <ElectronSettingRow
          settingKey="scrollbackLines"
          label="Scrollback Lines"
          description="Number of lines kept in terminal history"
          type="number"
          min={500}
          max={200000}
          step={5000}
        />
        <ElectronSettingRow
          settingKey="copyOnSelect"
          label="Copy on Select"
          description="Automatically copy text when selected in terminal"
          type="boolean"
        />
        <ElectronSettingRow
          settingKey="terminalBell"
          label="Terminal Bell"
          description="Play a sound on terminal bell character"
          type="boolean"
        />
        <ElectronSettingRow
          settingKey="terminalOsc52Clipboard"
          label="OSC 52 Clipboard"
          description="Allow terminal apps to set the system clipboard"
          type="select"
          options={[
            { value: 'allow', label: 'Always allow' },
            { value: 'off', label: 'Off' },
          ]}
        />
        <ElectronSettingRow
          settingKey="opencodeMousePassthrough"
          label="OpenCode Mouse Passthrough"
          description="Let OpenCode receive native terminal mouse events"
          type="boolean"
        />
        <ElectronSettingRow
          settingKey="terminalTransport"
          label="Live Transport"
          description="How terminal output is streamed from tmux"
          type="select"
          options={[
            { value: 'pty', label: 'PTY' },
            { value: 'classic', label: 'Classic' },
            { value: 'control', label: 'Control mode' },
          ]}
        />
      </div>
    </div>
  );
}
