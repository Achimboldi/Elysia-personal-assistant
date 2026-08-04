const { ipcRenderer } = require('electron');

let currentTask = null;
let tags = [];
let subtasks = [];

document.addEventListener('DOMContentLoaded', async () => {
  const editingTask = await ipcRenderer.invoke('get-current-editing-task');
  
  if (editingTask && editingTask.id) {
    const tasks = await ipcRenderer.invoke('get-tasks');
    const task = tasks.find(t => String(t.id) === String(editingTask.id));
    currentTask = task || editingTask;
    
    document.getElementById('pageTitle').textContent = '编辑任务';
    document.getElementById('deleteBtn').style.display = 'inline-block';
    loadTask(currentTask);
  } else {
    currentTask = null;
    document.getElementById('pageTitle').textContent = '新增任务';
    document.getElementById('deleteBtn').style.display = 'none';
    resetForm();
  }

  document.getElementById('saveBtn').addEventListener('click', async () => {
    await saveTask();
  });

  document.getElementById('cancelBtn').addEventListener('click', () => {
    ipcRenderer.invoke('clear-current-editing-task');
    window.close();
  });

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (confirm('确定要删除这个任务吗？此操作不可撤销。')) {
      await ipcRenderer.invoke('delete-task', currentTask.id);
      await ipcRenderer.invoke('clear-current-editing-task');
      await ipcRenderer.invoke('refresh-main');
      window.close();
    }
  });

  document.getElementById('addSubtaskBtn').addEventListener('click', addSubtask);
  
  ipcRenderer.on('tasks-updated', async () => {
    if (currentTask && currentTask.id) {
      const tasks = await ipcRenderer.invoke('get-tasks');
      const updatedTask = tasks.find(t => String(t.id) === String(currentTask.id));
      if (updatedTask) {
        currentTask = updatedTask;
        loadTask(currentTask);
      }
    }
  });

  setupTagsInput();
});

function resetForm() {
  document.getElementById('title').value = '';
  document.getElementById('description').value = '';
  document.getElementById('startDate').value = '';
  document.getElementById('endDate').value = '';
  document.getElementById('priority').value = 'normal';
  document.getElementById('progress').value = 'pending';
  tags = [];
  subtasks = [];
  renderTags();
  renderSubtasks();
}

function loadTask(task) {
  document.getElementById('title').value = task.title || '';
  document.getElementById('description').value = task.description || '';
  document.getElementById('startDate').value = task.startDate || '';
  document.getElementById('endDate').value = task.endDate || '';
  document.getElementById('priority').value = task.priority || 'normal';
  document.getElementById('progress').value = task.progress || 'pending';
  tags = task.tags || [];
  subtasks = task.subtasks || [];
  renderTags();
  renderSubtasks();
}

function addSubtask() {
  const newSubtask = {
    id: Date.now().toString(),
    title: '',
    dueDate: '',
    completed: false,
    priority: 'normal',
    progress: 'pending'
  };
  subtasks.push(newSubtask);
  renderSubtasks();
  
  setTimeout(() => {
    const lastInput = document.querySelector('.subtask-title:last-child');
    if (lastInput) lastInput.focus();
  }, 50);
}

function removeSubtask(index) {
  subtasks.splice(index, 1);
  renderSubtasks();
}

function updateSubtask(index, field, value) {
  if (subtasks[index]) {
    subtasks[index][field] = value;
  }
}

function toggleSubtaskCompleted(index) {
  if (subtasks[index]) {
    subtasks[index].progress = subtasks[index].progress === 'completed' ? 'pending' : 'completed';
    subtasks[index].completed = subtasks[index].progress === 'completed';
    renderSubtasks();
  }
}

function renderSubtasks() {
  const container = document.getElementById('subtasksContainer');
  
  if (subtasks.length === 0) {
    container.innerHTML = '<div class="no-subtasks">暂无子任务，点击上方按钮添加</div>';
    return;
  }

  container.innerHTML = subtasks.map((subtask, index) => {
    const isCompleted = subtask.progress === 'completed';
    return `
    <div class="subtask-item" data-index="${index}">
      <label class="subtask-checkbox">
        <input type="checkbox" ${isCompleted ? 'checked' : ''} 
               onchange="toggleSubtaskCompleted(${index})">
      </label>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
        <div class="subtask-title" contenteditable="${!isCompleted ? 'true' : 'false'}"
             data-placeholder="子任务标题"
             oninput="updateSubtask(${index}, 'title', this.textContent.trim())">${subtask.title || ''}</div>
        <div class="subtask-controls">
          <input type="date" class="subtask-date" 
                 value="${subtask.dueDate || ''}" 
                 onchange="updateSubtask(${index}, 'dueDate', this.value)"
                 ${isCompleted ? 'disabled' : ''}>
          <select class="subtask-priority" 
                  onchange="updateSubtask(${index}, 'priority', this.value)"
                  ${isCompleted ? 'disabled' : ''}>
            <option value="secondary" ${subtask.priority === 'secondary' ? 'selected' : ''}>次要</option>
            <option value="normal" ${subtask.priority === 'normal' || !subtask.priority ? 'selected' : ''}>普通</option>
            <option value="priority" ${subtask.priority === 'priority' ? 'selected' : ''}>优先</option>
            <option value="urgent" ${subtask.priority === 'urgent' ? 'selected' : ''}>紧急</option>
          </select>
          <button class="btn-delete-subtask" onclick="removeSubtask(${index})">×</button>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

async function saveTask() {
  const title = document.getElementById('title').value.trim();
  const description = document.getElementById('description').value.trim();
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;

  if (!title || !startDate || !endDate) {
    alert('请填写任务标题、开始时间和截止时间');
    return;
  }

  const validSubtasks = subtasks.filter(s => s.title.trim());
  
  const progress = document.getElementById('progress').value;
  const priority = document.getElementById('priority').value;

  if (currentTask) {
    // ★ 修复：只提交有差异的字段，避免表单里的旧值（优先级/进度等）覆盖主界面新改动
    const patch = {};
    if (title !== (currentTask.title || '')) patch.title = title;
    if (description !== (currentTask.description || '')) patch.description = description;
    if (startDate !== (currentTask.startDate || '')) patch.startDate = startDate;
    if (endDate !== (currentTask.endDate || '')) patch.endDate = endDate;
    if (priority !== (currentTask.priority || 'normal')) patch.priority = priority;
    if (progress !== (currentTask.progress || 'pending')) patch.progress = progress;
    if (JSON.stringify(tags || []) !== JSON.stringify(currentTask.tags || [])) patch.tags = tags;
    if (JSON.stringify(validSubtasks) !== JSON.stringify(currentTask.subtasks || [])) patch.subtasks = validSubtasks;
    if (progress === 'completed' && currentTask.completed !== true) patch.completed = true;
    if (progress !== 'completed' && currentTask.completed === true) patch.completed = false;
    if (Object.keys(patch).length > 0) {
      await ipcRenderer.invoke('update-task', currentTask.id, patch);
    }
  } else {
    const taskData = {
      title: title,
      description: description,
      startDate: startDate,
      endDate: endDate,
      priority: priority,
      progress: progress,
      completed: progress === 'completed',
      tags: tags,
      subtasks: validSubtasks
    };
    await ipcRenderer.invoke('add-task', taskData);
  }

  await ipcRenderer.invoke('clear-current-editing-task');
  await ipcRenderer.invoke('refresh-main');
  window.close();
}

function setupTagsInput() {
  const tagInput = document.getElementById('tagInput');
  const presetTags = document.querySelectorAll('.preset-tag');

  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && tagInput.value.trim()) {
      e.preventDefault();
      addTag(tagInput.value.trim());
      tagInput.value = '';
    }
  });

  presetTags.forEach(tag => {
    tag.addEventListener('click', () => {
      addTag(tag.dataset.tag);
    });
  });
}

function addTag(tag) {
  if (!tags.includes(tag)) {
    tags.push(tag);
    renderTags();
  }
}

function removeTag(tag) {
  tags = tags.filter(t => t !== tag);
  renderTags();
}

function renderTags() {
  const container = document.getElementById('tagsContainer');
  container.innerHTML = tags.map(tag => `
    <span class="tag-item">
      ${tag}
      <span class="remove-tag" onclick="removeTag('${tag}')">×</span>
    </span>
  `).join('');
}

window.removeTag = removeTag;
window.toggleSubtaskCompleted = toggleSubtaskCompleted;
window.updateSubtask = updateSubtask;
window.removeSubtask = removeSubtask;
