const { ipcRenderer } = require('electron');

let currentTask = null;

document.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.on('show-reminder', (event, task) => {
        currentTask = task;
        displayReminder(task);
    });

    document.getElementById('viewBtn').addEventListener('click', () => {
        if (currentTask) {
            ipcRenderer.send(`reminder-clicked-${currentTask.id}`);
            ipcRenderer.invoke('edit-task-from-reminder', currentTask);
        }
        ipcRenderer.invoke('close-reminder', currentTask.id);
    });

    document.getElementById('snoozeBtn').addEventListener('click', () => {
        ipcRenderer.invoke('snooze-reminder', currentTask.id);
    });
});

function displayReminder(task) {
    document.getElementById('taskTitle').textContent = task.title;

    const dueDate = new Date(task.endDate || task.dueDate);
    const now = new Date();
    const diffMinutes = Math.round((dueDate - now) / (1000 * 60));

    let timeText = '';
    if (diffMinutes > 60) {
        const hours = Math.floor(diffMinutes / 60);
        const mins = diffMinutes % 60;
        timeText = `将于 ${hours} 小时 ${mins} 分钟后截止`;
    } else if (diffMinutes > 0) {
        timeText = `将于 ${diffMinutes} 分钟后截止`;
    } else {
        timeText = '已超过截止时间';
    }

    document.getElementById('taskRemaining').textContent = timeText;
}
