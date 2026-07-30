const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('quickSaveBtn').addEventListener('click', async () => {
        const title = document.getElementById('quickTitle').value;
        if (!title || !title.trim()) {
            alert('请输入任务标题');
            return;
        }
        
        const taskData = {
            title: title,
            description: '',
            startDate: new Date().toISOString().split('T')[0],
            endDate: document.getElementById('quickDueDate').value,
            priority: 'normal',
            progress: 'pending',
            tags: [],
            completed: false,
            createdAt: new Date().toISOString(),
            subtasks: []
        };

        await ipcRenderer.invoke('add-task', taskData);
        await ipcRenderer.invoke('refresh-main');
        window.close();
    });

    document.getElementById('quickCancelBtn').addEventListener('click', () => {
        window.close();
    });

    document.getElementById('cancelQuickBtn').addEventListener('click', () => {
        window.close();
    });
});
