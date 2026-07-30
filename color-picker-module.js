const { ipcMain, desktopCapturer, screen, BrowserWindow } = require('electron');
const uIOhook = require('uiohook-napi');
const path = require('path');

let colorPickerWindow = null;
let isColorPickerActive = false;
let stickyNoteToColor = null;

// 初始化取色器相关的 IPC 处理
function setupColorPicker() {
    // 开始取色
    ipcMain.handle('start-color-picker', (event, memoId) => {
        if (isColorPickerActive) return;
        
        stickyNoteToColor = memoId;
        createColorPickerWindow();
    });
    
    // 停止取色
    ipcMain.handle('stop-color-picker', () => {
        stopColorPicker();
    });
    
    // 应用颜色
    ipcMain.handle('apply-color', (event, color) => {
        applyColorToSticky(color);
    });
}

// 创建取色器窗口
function createColorPickerWindow() {
    // 获取所有显示器
    const displays = screen.getAllDisplays();
    const primaryDisplay = displays[0];
    
    // 创建全屏透明窗口
    colorPickerWindow = new BrowserWindow({
        width: primaryDisplay.bounds.width,
        height: primaryDisplay.bounds.height,
        x: 0,
        y: 0,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    
    colorPickerWindow.loadFile(path.join(__dirname, 'color-picker.html'));
    colorPickerWindow.setIgnoreMouseEvents(false);
    isColorPickerActive = true;
    
    colorPickerWindow.on('closed', () => {
        colorPickerWindow = null;
        isColorPickerActive = false;
    });
}

// 停止取色
function stopColorPicker() {
    if (colorPickerWindow && !colorPickerWindow.isDestroyed()) {
        colorPickerWindow.close();
    }
    isColorPickerActive = false;
}

// 应用颜色到便利贴
function applyColorToSticky(color) {
    if (stickyNoteToColor && mainWindow && !mainWindow.isDestroyed()) {
        // 这里可以发送事件给便利贴应用颜色
        // 实际应用逻辑可以在便利贴窗口的渲染进程处理
        const sticky = stickyNoteWindows.find(s => s.memoId === stickyNoteToColor);
        if (sticky && sticky.window && !sticky.window.isDestroyed()) {
            sticky.window.webContents.send('apply-color', color);
        }
    }
    stopColorPicker();
}

module.exports = { setupColorPicker };
