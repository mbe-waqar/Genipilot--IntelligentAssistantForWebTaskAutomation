/**
 * Dynamic Dashboard JavaScript
 * Fetches and displays real-time automation data
 */

// API Base URL
const API_BASE_URL = 'http://localhost:8000';
const AGENT_SERVER_URL = 'http://localhost:5005';

// Global state
let allHistory = [];
let allScheduledTasks = [];
let statsData = {};
let agentHealth = {
    ready_for_automation: false,
    browser: { connected: false },
    scheduler: { initialized: false, running: false }
};
let dashboardWs = null;  // WebSocket for real-time notifications
let currentUserEmail = null;  // Populated from profile fetch

// ============================================================================
// Data Fetching Functions
// ============================================================================

async function fetchAgentHealth() {
    try {
        const response = await fetch(`${AGENT_SERVER_URL}/health`, {
            signal: AbortSignal.timeout(3000) // 3 second timeout
        });

        if (!response.ok) {
            throw new Error('Agent server not responding');
        }

        const result = await response.json();
        agentHealth = result;
        updateAgentStatusIndicator(result);
        updateScheduleFormState(result.ready_for_automation);

        return result;
    } catch (error) {
        console.error('Error fetching agent health:', error);
        agentHealth = {
            ready_for_automation: false,
            browser: { connected: false },
            scheduler: { initialized: false, running: false },
            status: 'offline'
        };
        updateAgentStatusIndicator(agentHealth);
        updateScheduleFormState(false);
        return agentHealth;
    }
}

async function fetchDashboardStats() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/dashboard/stats`, {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch stats');
        }

        const result = await response.json();

        if (result.success) {
            statsData = result.data;
            updateStatsCards(statsData);
        }
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
    }
}

async function fetchAutomationHistory(limit = 50) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/automation/history?limit=${limit}`, {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch history');
        }

        const result = await response.json();

        if (result.success) {
            allHistory = result.data;
            updateHistoryTable(allHistory);
            updateCharts(allHistory);
        }
    } catch (error) {
        console.error('Error fetching automation history:', error);
    }
}

async function fetchScheduledTasks() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/scheduled-tasks`, {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch scheduled tasks');
        }

        const result = await response.json();

        if (result.success) {
            allScheduledTasks = result.data;
            updateScheduledTasksList(allScheduledTasks);
            updateScheduledStatCard();
        }
    } catch (error) {
        console.error('Error fetching scheduled tasks:', error);
    }
}

// ============================================================================
// UI Update Functions
// ============================================================================

function updateStatsCards(stats) {
    // Total Tasks
    const totalTasksEl = document.getElementById('statTotalTasks');
    if (totalTasksEl) {
        animateCounter(totalTasksEl, stats.total_tasks || 0);
    }

    // Success Rate
    const successRateEl = document.getElementById('statSuccessRate');
    if (successRateEl) {
        animateCounter(successRateEl, stats.success_rate || 0, '%');
    }

    // Scheduled Tasks count
    updateScheduledStatCard();
}

function updateScheduledStatCard() {
    const countEl = document.getElementById('statScheduledCount');
    const labelEl = document.getElementById('statNextRun');
    if (!countEl) return;

    const activeCount = allScheduledTasks ? allScheduledTasks.filter(t => t.is_active).length : 0;
    animateCounter(countEl, activeCount);

    if (labelEl) {
        // Find the next upcoming run
        const now = new Date();
        let nearest = null;
        (allScheduledTasks || []).forEach(t => {
            if (t.is_active && t.next_run) {
                const nr = new Date(t.next_run);
                if (nr > now && (!nearest || nr < nearest)) nearest = nr;
            }
        });
        if (nearest) {
            const diff = nearest - now;
            const mins = Math.floor(diff / 60000);
            const hrs = Math.floor(mins / 60);
            labelEl.textContent = hrs > 0 ? `Next run in ${hrs}h ${mins % 60}m` : `Next run in ${mins}m`;
        } else {
            labelEl.textContent = activeCount > 0 ? 'Active schedules' : 'No active schedules';
        }
    }
}

function animateCounter(el, target, suffix = '') {
    const duration = 600;
    const start = parseInt(el.textContent) || 0;
    if (start === target) { el.textContent = target + suffix; return; }
    const startTime = performance.now();
    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (target - start) * eased);
        el.textContent = current + suffix;
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function updateHistoryTable(history) {
    // Update recent history table (on overview page)
    const recentTableBody = document.querySelector('#taskTable tbody');

    if (recentTableBody) {
        recentTableBody.innerHTML = '';

        const recentHistory = history.slice(0, 5); // Show last 5

        if (recentHistory.length === 0) {
            recentTableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center text-muted">
                        No automation tasks yet. Try running a task from the extension!
                    </td>
                </tr>
            `;
        } else {
            recentHistory.forEach(task => {
                const row = createHistoryTableRow(task, false);
                recentTableBody.appendChild(row);
            });
        }
    }

    // Update full history table (on history page)
    const fullTableBody = document.querySelector('#history-section table tbody');

    if (fullTableBody) {
        fullTableBody.innerHTML = '';

        if (history.length === 0) {
            fullTableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center text-muted">
                        No automation history available
                    </td>
                </tr>
            `;
        } else {
            history.forEach((task, index) => {
                const row = createHistoryTableRow(task, true, index + 1);
                fullTableBody.appendChild(row);
            });
        }
    }
}

function createHistoryTableRow(task, fullView = false, taskId = null) {
    const row = document.createElement('tr');
    row.dataset.status = task.status;

    const startTime = new Date(task.start_time);
    const formattedDate = startTime.toLocaleString();
    const duration = task.duration_seconds
        ? formatDuration(task.duration_seconds)
        : '-';

    const statusClass = {
        'success': 'status-success',
        'failed': 'status-failed',
        'pending': 'status-pending',
        'running': 'status-pending'
    }[task.status] || 'status-pending';

    const statusText = task.status.charAt(0).toUpperCase() + task.status.slice(1);

    if (fullView) {
        // Full view with ID column
        row.innerHTML = `
            <td>#${String(taskId).padStart(3, '0')}</td>
            <td><strong>${escapeHtml(task.task_name)}</strong></td>
            <td>Automation</td>
            <td>${formattedDate}</td>
            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
            <td>${duration}</td>
            <td>
                <button class="btn btn-sm btn-outline-primary" onclick="showTaskDetails('${task._id}')">Details</button>
                ${task.status === 'failed' ? `<button class="btn btn-sm btn-outline-secondary" onclick="retryTask('${task._id}')">Retry</button>` : ''}
            </td>
        `;
    } else {
        // Compact view for recent tasks
        row.innerHTML = `
            <td><strong>${escapeHtml(task.task_name)}</strong></td>
            <td>${formattedDate}</td>
            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
            <td>${duration}</td>
            <td><button class="btn btn-sm btn-outline-primary btn-details" onclick="showTaskDetails('${task._id}')">View</button></td>
        `;
    }

    return row;
}

function buildScheduledTaskCard(task, compact) {
    const scheduleDescription = getScheduleDescription(task.frequency, task.schedule_time);
    const statusBadge = getExecutionStatusBadge(task);
    const isRunning = task.last_execution_status === 'running';
    const isActive = task.is_active;

    // Border color based on state
    let borderColor = isRunning ? '#016B61' : isActive ? '#059669' : '#718096';
    let bgTint = isRunning ? 'rgba(1,107,97,0.04)' : isActive ? 'rgba(5,150,105,0.03)' : 'rgba(113,128,150,0.03)';
    let pulseClass = isRunning ? 'scheduled-task-running' : '';

    // Time remaining / last run info
    let timeHtml = '';
    if (isActive && task.next_run) {
        const nextRunDate = new Date(task.next_run);
        const timeDiff = nextRunDate - new Date();
        if (timeDiff > 0) {
            timeHtml = `
                <div class="mt-2 px-2 py-1" style="background:#F0F7F6; border-left:3px solid #016B61; border-radius:4px; font-size:0.8rem;">
                    <i class="bi bi-clock" style="color:#016B61;"></i> <strong>Next:</strong> ${nextRunDate.toLocaleString()}
                    &nbsp;<span class="countdown" data-next-run="${task.next_run}" style="color:#016B61; font-weight:600;">${formatTimeRemaining(timeDiff)}</span>
                </div>`;
        } else {
            timeHtml = `<small class="text-muted d-block mt-1"><i class="bi bi-clock-history"></i> Running soon...</small>`;
        }
    } else if (task.last_run) {
        timeHtml = `<small class="text-muted d-block mt-1"><i class="bi bi-check-circle"></i> Last run: ${new Date(task.last_run).toLocaleString()}</small>`;
    }

    const card = document.createElement('div');
    card.className = `position-relative mb-2 ${pulseClass}`;
    card.dataset.taskId = task._id;
    card.style.cssText = `border-left: 4px solid ${borderColor}; border-radius: 8px; padding: 12px 14px; background: ${bgTint}; box-shadow: 0 1px 4px rgba(0,0,0,0.06); transition: box-shadow 0.2s, transform 0.2s;`;

    card.onmouseover = function() { this.style.boxShadow = '0 3px 12px rgba(0,0,0,0.1)'; this.style.transform = 'translateY(-1px)'; };
    card.onmouseout = function() { this.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)'; this.style.transform = 'translateY(0)'; };

    // Delete overlay (top-right)
    const deleteOverlay = `
        <span onclick="event.stopPropagation(); deleteScheduledTask('${task._id}')" title="Delete" style="
            position:absolute; top:6px; right:6px; width:26px; height:26px;
            background:linear-gradient(135deg,#0a2a25,#016B61); border-radius:7px; cursor:pointer;
            font-size:12px; line-height:26px; text-align:center; color:#fff;
            box-shadow:0 2px 6px rgba(1,107,97,0.2);
            transition: all 0.25s ease; z-index:2;
        " onmouseover="this.style.background='linear-gradient(135deg,#b91c1c,#e53935)'; this.style.boxShadow='0 3px 10px rgba(229,57,53,0.3)'; this.style.transform='scale(1.12)'"
           onmouseout="this.style.background='linear-gradient(135deg,#0a2a25,#016B61)'; this.style.boxShadow='0 2px 6px rgba(1,107,97,0.2)'; this.style.transform='scale(1)'">
            <i class="bi bi-x-lg" style="font-size:11px;"></i>
        </span>`;

    if (compact) {
        card.innerHTML = `
            ${deleteOverlay}
            <div class="d-flex align-items-center gap-2 mb-1" style="padding-right:28px;">
                <span style="font-size:1.1rem;">${isActive ? (isRunning ? '<i class="bi bi-arrow-repeat text-primary"></i>' : '<i class="bi bi-calendar-check text-success"></i>') : '<i class="bi bi-calendar-x text-secondary"></i>'}</span>
                <h6 class="mb-0" style="font-size:0.88rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;">${escapeHtml(task.task_name)}</h6>
                ${statusBadge}
            </div>
            <small class="text-muted d-block" style="font-size:0.78rem;"><i class="bi bi-calendar-event"></i> ${scheduleDescription}</small>
            <div class="mt-2 d-flex gap-1">
                <button class="btn btn-success btn-sm" style="font-size:0.72rem; padding:2px 8px;" onclick="startTask('${task._id}')" title="Run Now" ${isRunning ? 'disabled' : ''}><i class="bi bi-play-circle-fill"></i></button>
                ${isActive
                    ? `<button class="btn btn-warning btn-sm" style="font-size:0.72rem; padding:2px 8px;" onclick="pauseTask('${task._id}')" title="Pause"><i class="bi bi-pause-fill"></i></button>`
                    : `<button class="btn btn-outline-success btn-sm" style="font-size:0.72rem; padding:2px 8px;" onclick="resumeTask('${task._id}')" title="Resume"><i class="bi bi-arrow-clockwise"></i></button>`
                }
                <button class="btn btn-outline-secondary btn-sm" style="font-size:0.72rem; padding:2px 8px;" onclick="showScheduledTaskDetails('${task._id}')" title="Details"><i class="bi bi-info-circle"></i></button>
            </div>
        `;
    } else {
        card.innerHTML = `
            ${deleteOverlay}
            <div class="d-flex justify-content-between align-items-start">
                <div class="flex-grow-1" style="padding-right:30px;">
                    <div class="d-flex align-items-center gap-2 mb-1">
                        <span style="font-size:1.2rem;">${isActive ? (isRunning ? '<i class="bi bi-arrow-repeat text-primary"></i>' : '<i class="bi bi-calendar-check text-success"></i>') : '<i class="bi bi-calendar-x text-secondary"></i>'}</span>
                        <h6 class="mb-0">${escapeHtml(task.task_name)}</h6>
                        ${statusBadge}
                    </div>
                    <small class="text-muted d-block"><i class="bi bi-calendar-event"></i> ${scheduleDescription}</small>
                    <small class="text-muted d-block mt-1" style="font-size:0.82rem;"><i class="bi bi-card-text"></i> ${escapeHtml(task.task_description)}</small>
                    ${timeHtml}
                </div>
                <div class="btn-group btn-group-sm" style="margin-top:2px;">
                    <button class="btn btn-success" onclick="startTask('${task._id}')" title="Run Now" ${isRunning ? 'disabled' : ''}><i class="bi bi-play-circle-fill"></i></button>
                    ${isActive
                        ? `<button class="btn btn-warning" onclick="pauseTask('${task._id}')" title="Pause"><i class="bi bi-pause-fill"></i></button>`
                        : `<button class="btn btn-outline-success" onclick="resumeTask('${task._id}')" title="Resume"><i class="bi bi-arrow-clockwise"></i></button>`
                    }
                </div>
            </div>
            <button class="btn btn-outline-secondary btn-sm w-100 mt-2" style="font-size:0.8rem;" onclick="showScheduledTaskDetails('${task._id}')"><i class="bi bi-info-circle"></i> Details</button>
        `;
    }

    return card;
}

function updateScheduledTasksList(tasks) {
    const listContainer = document.querySelector('#scheduled-section .list-group');
    const activeSchedulesList = document.getElementById('activeSchedulesList');

    if (!listContainer) return;

    listContainer.innerHTML = '';

    if (tasks.length === 0) {
        listContainer.innerHTML = `<div class="text-center text-muted py-4"><i class="bi bi-calendar-plus" style="font-size:2rem; opacity:0.4;"></i><p class="mt-2 mb-0">No scheduled tasks. Create one using the form!</p></div>`;
        if (activeSchedulesList) activeSchedulesList.innerHTML = `<div class="text-center text-muted py-3"><p class="mb-0">No scheduled tasks yet</p></div>`;
        return;
    }

    tasks.forEach(task => {
        listContainer.appendChild(buildScheduledTaskCard(task, false));
    });

    startCountdownTimers();

    // Compact sidebar list
    if (activeSchedulesList) {
        activeSchedulesList.innerHTML = '';
        tasks.slice(0, 5).forEach(task => {
            activeSchedulesList.appendChild(buildScheduledTaskCard(task, true));
        });
    }
}

function updateCharts(history) {
    // Update line chart with task execution over time
    updateLineChart(history);

    // Update pie chart with task status distribution
    updatePieChart(history);
}

function updateLineChart(history) {
    if (!window.lineChart) return;

    // Group tasks by day
    const last7Days = getLast7Days();
    const taskCounts = new Array(7).fill(0);

    history.forEach(task => {
        const taskDate = new Date(task.start_time).toDateString();
        const index = last7Days.findIndex(d => d.toDateString() === taskDate);

        if (index !== -1) {
            taskCounts[index]++;
        }
    });

    window.lineChart.data.labels = last7Days.map(d =>
        d.toLocaleDateString('en-US', { weekday: 'short' })
    );
    window.lineChart.data.datasets[0].data = taskCounts;
    window.lineChart.update();
}

function updatePieChart(history) {
    if (!window.pieChart) return;

    // Count by status
    const statusCounts = {
        success: 0,
        failed: 0,
        pending: 0
    };

    history.forEach(task => {
        if (statusCounts.hasOwnProperty(task.status)) {
            statusCounts[task.status]++;
        }
    });

    window.pieChart.data.labels = ['Success', 'Failed', 'Pending'];
    window.pieChart.data.datasets[0].data = [
        statusCounts.success,
        statusCounts.failed,
        statusCounts.pending
    ];
    window.pieChart.update();
}

// ============================================================================
// Agent Health Status Management
// ============================================================================

function updateAgentStatusIndicator(health) {
    // Update the status indicator in the schedule task form
    let statusHtml = '';

    if (health.ready_for_automation) {
        statusHtml = `
            <div class="alert alert-success mb-3" role="alert">
                <i class="bi bi-check-circle-fill"></i>
                <strong>Agent Ready</strong> - Browser and scheduler are running
            </div>
        `;
    } else {
        const issues = [];
        if (!health.browser || !health.browser.connected) {
            issues.push('Browser not connected');
        }
        if (!health.scheduler || !health.scheduler.initialized) {
            issues.push('Scheduler not initialized');
        }
        if (!health.scheduler || !health.scheduler.running) {
            issues.push('Scheduler not running');
        }

        statusHtml = `
            <div class="alert alert-danger mb-3" role="alert">
                <i class="bi bi-exclamation-triangle-fill"></i>
                <strong>Agent Not Ready</strong><br>
                <small>${issues.join(', ')}</small><br>
                <small class="text-muted">Please ensure the agent server is running with Chrome CDP enabled.</small>
            </div>
        `;
    }

    // Insert status indicator before the form (if it exists)
    const form = document.getElementById('createScheduledTaskForm');
    if (form) {
        // Remove existing status indicator
        const existingIndicator = form.previousElementSibling;
        if (existingIndicator && existingIndicator.classList.contains('alert')) {
            existingIndicator.remove();
        }

        // Insert new status indicator
        form.insertAdjacentHTML('beforebegin', statusHtml);
    }
}

function updateScheduleFormState(isReady) {
    const form = document.getElementById('createScheduledTaskForm');
    const submitButton = form ? form.querySelector('button[type="submit"]') : null;

    if (submitButton) {
        submitButton.disabled = !isReady;

        if (!isReady) {
            submitButton.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Agent Offline - Cannot Schedule';
            submitButton.classList.remove('btn-primary');
            submitButton.classList.add('btn-secondary');
        } else {
            submitButton.innerHTML = '<i class="bi bi-plus-circle"></i> Schedule Task';
            submitButton.classList.remove('btn-secondary');
            submitButton.classList.add('btn-primary');
        }
    }

    // Also disable all form inputs when agent is offline
    if (form) {
        const inputs = form.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
            input.disabled = !isReady;
        });
    }
}

// ============================================================================
// Scheduled Task Management
// ============================================================================

async function createScheduledTask(event) {
    event.preventDefault();

    // Double-check agent health before creating task
    if (!agentHealth.ready_for_automation) {
        alert('❌ Cannot create scheduled task: Agent server is not ready. Please check:\n' +
              '- Agent server is running (port 5005)\n' +
              '- Browser is connected via CDP (port 9222)\n' +
              '- Scheduler is initialized');
        return;
    }

    const form = event.target;
    const formData = new FormData(form);

    const automationPrompt = formData.get('automation_prompt');
    const frequency = formData.get('frequency');

    // Use automation prompt as task name (truncate to 100 chars if needed)
    const taskName = automationPrompt.length > 100
        ? automationPrompt.substring(0, 97) + '...'
        : automationPrompt;

    const taskData = {
        task_name: taskName,
        task_description: automationPrompt,
        automation_prompt: automationPrompt,
        frequency: frequency,
        schedule_time: formatScheduleTime(
            frequency,
            formData.get('time'),
            formData.get('day_of_week'),
            formData.get('date')
        )
    };

    try {
        const response = await fetch(`${API_BASE_URL}/api/scheduled-tasks`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(taskData)
        });

        const result = await response.json();

        if (result.success) {
            alert('✅ Scheduled task created successfully!');
            form.reset();
            await fetchScheduledTasks();
        } else {
            alert(`❌ Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Error creating scheduled task:', error);
        alert(`❌ Error creating scheduled task: ${error.message}`);
    }
}

// ============================================================================
// Centralized Execution-Aware Task Controls
// ============================================================================

async function cancelExecution(taskId) {
    /**
     * Cancel any currently running execution for this task's user.
     * Calls the agent server cancel endpoint to set the cancellation flag.
     */
    const task = allScheduledTasks.find(t => t._id === taskId);
    if (!task) return;
    try {
        await fetch(`${AGENT_SERVER_URL}/api/scheduler/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_email: task.user_email })
        });
    } catch (e) {
        console.warn('Could not cancel execution:', e);
    }
}

async function setTaskActive(taskId, active) {
    /** Set task is_active flag in DB and sync scheduler. */
    const response = await fetch(`${API_BASE_URL}/api/scheduled-tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: active })
    });
    return await response.json();
}

async function startTask(taskId) {
    /**
     * RUN NOW — always clickable.
     * If task is executing: cancel first, then restart from beginning.
     * If task is paused: re-activate, then run.
     */
    const task = allScheduledTasks.find(t => t._id === taskId);
    if (!task) return;

    const isRunning = task.last_execution_status === 'running';
    const isActive = task.is_active !== false;

    try {
        // Cancel any running execution first
        if (isRunning) {
            await cancelExecution(taskId);
        }
        // If paused, re-activate so scheduler picks it up
        if (!isActive) {
            await setTaskActive(taskId, true);
        }
        // Fire the run
        const response = await fetch(`${API_BASE_URL}/api/scheduled-tasks/${taskId}/run`, {
            method: 'POST',
            credentials: 'include'
        });
        const result = await response.json();
        if (result.success) {
            showToast('Task started from the beginning.', 'success');
        } else {
            showToast(`Error: ${result.error}`, 'danger');
        }
        await fetchScheduledTasks();
    } catch (error) {
        console.error('startTask error:', error);
        showToast(`Error: ${error.message}`, 'danger');
    }
}

async function pauseTask(taskId) {
    /**
     * PAUSE — always clickable.
     * Stops any running execution immediately, then marks task as paused.
     */
    try {
        // Cancel running execution regardless of UI state
        await cancelExecution(taskId);
        // Set task inactive (removes from scheduler + sets DB flag)
        const result = await setTaskActive(taskId, false);
        if (result.success) {
            showToast('Task paused.', 'warning');
        } else {
            showToast(`Error: ${result.error}`, 'danger');
        }
        await fetchScheduledTasks();
    } catch (error) {
        console.error('pauseTask error:', error);
        showToast(`Error: ${error.message}`, 'danger');
    }
}

async function resumeTask(taskId) {
    /**
     * RESUME — re-activates the task and lets the scheduler handle timing.
     * If the scheduled time matches now, the scheduler will run it.
     * Otherwise, task goes back to Pending until the next scheduled time.
     */
    try {
        // Re-activate — this calls /api/scheduler/reload which re-adds to APScheduler
        const result = await setTaskActive(taskId, true);
        if (result.success) {
            showToast('Task resumed. Will run at next scheduled time.', 'success');
        } else {
            showToast(`Error: ${result.error}`, 'danger');
        }
        await fetchScheduledTasks();
    } catch (error) {
        console.error('resumeTask error:', error);
        showToast(`Error: ${error.message}`, 'danger');
    }
}

// Legacy wrapper kept for any remaining callers
async function toggleTaskStatus(taskId, newStatus) {
    if (newStatus) {
        await resumeTask(taskId);
    } else {
        await pauseTask(taskId);
    }
}

async function deleteScheduledTask(taskId) {
    if (!confirm('Are you sure you want to delete this scheduled task?')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/scheduled-tasks/${taskId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const result = await response.json();

        if (result.success) {
            await fetchScheduledTasks();
        } else {
            alert(`❌ Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Error deleting task:', error);
        alert(`❌ Error: ${error.message}`);
    }
}

// runTaskNow kept as alias for backward compatibility
async function runTaskNow(taskId) {
    await startTask(taskId);
}

// ============================================================================
// Task Details Modal
// ============================================================================

async function showTaskDetails(taskId) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/automation/history/${taskId}`, {
            credentials: 'include'
        });

        const result = await response.json();

        if (result.success) {
            const task = result.data;
            displayTaskDetailsModal(task);
        } else {
            alert(`❌ Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Error fetching task details:', error);
        alert(`❌ Error: ${error.message}`);
    }
}

function displayTaskDetailsModal(task) {
    const startTime = new Date(task.start_time).toLocaleString();
    const endTime = task.end_time ? new Date(task.end_time).toLocaleString() : 'N/A';
    const duration = task.duration_seconds ? formatDuration(task.duration_seconds) : 'N/A';

    const statusClass = {
        'success': 'bg-success',
        'failed': 'bg-danger',
        'pending': 'bg-warning',
        'running': 'bg-primary'
    }[task.status] || 'bg-secondary';

    const urlsHtml = task.urls_visited && task.urls_visited.length > 0
        ? '<ul class="mb-0">' + task.urls_visited.map(url => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></li>`).join('') + '</ul>'
        : '<span class="text-muted">No URLs recorded</span>';

    const errorsHtml = task.errors && task.errors.length > 0
        ? '<ul class="mb-0 text-danger">' + task.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('') + '</ul>'
        : '<span class="text-muted">No errors</span>';

    const modalTitle = document.getElementById('taskDetailsModalLabel');
    const modalBody = document.getElementById('taskDetailsModalBody');

    modalTitle.textContent = task.task_name || 'Task Details';
    modalBody.innerHTML = `
        <div class="mb-3">
            <span class="badge ${statusClass} mb-2">${(task.status || '').toUpperCase()}</span>
        </div>
        ${task.task_description ? `<div class="mb-3"><strong>Description:</strong><p class="mb-0">${escapeHtml(task.task_description)}</p></div>` : ''}
        <div class="row mb-3">
            <div class="col-sm-4"><strong>Started:</strong><br>${startTime}</div>
            <div class="col-sm-4"><strong>Ended:</strong><br>${endTime}</div>
            <div class="col-sm-4"><strong>Duration:</strong><br>${duration}</div>
        </div>
        <div class="mb-3"><strong>Steps Executed:</strong> ${task.steps_count || 0}</div>
        <div class="mb-3"><strong>URLs Visited:</strong>${urlsHtml}</div>
        <div class="mb-3"><strong>Final Result:</strong><p class="mb-0">${escapeHtml(task.final_result || 'No result available')}</p></div>
        <div class="mb-3"><strong>Errors:</strong>${errorsHtml}</div>
    `;

    const modal = new bootstrap.Modal(document.getElementById('taskDetailsModal'));
    modal.show();
}

async function retryTask(taskId) {
    // TODO: Implement retry functionality
    alert('Retry functionality coming soon!');
}

// ============================================================================
// Scheduled Task Details Modal
// ============================================================================

function showScheduledTaskDetails(taskId) {
    const task = allScheduledTasks.find(t => t._id === taskId);
    if (!task) {
        alert('Task not found');
        return;
    }

    const isActive = task.is_active !== false;
    const statusBadge = isActive
        ? '<span class="badge bg-success">Active</span>'
        : '<span class="badge bg-secondary">Paused</span>';

    const lastExecBadge = task.last_execution_status
        ? (task.last_execution_status === 'running'
            ? '<span class="badge bg-primary">Running</span>'
            : task.last_execution_status === 'success'
                ? '<span class="badge bg-success">Success</span>'
                : '<span class="badge bg-danger">Failed</span>')
        : '<span class="badge bg-secondary">Never Run</span>';

    const lastRun = task.last_run ? new Date(task.last_run).toLocaleString() : 'Never';
    const nextRun = task.next_run ? new Date(task.next_run).toLocaleString() : 'Not scheduled';

    // Format schedule time for display
    let scheduleDisplay = task.schedule_time || 'N/A';
    const freq = (task.frequency || '').charAt(0).toUpperCase() + (task.frequency || '').slice(1);

    const modalTitle = document.getElementById('scheduledTaskDetailsModalLabel');
    const modalBody = document.getElementById('scheduledTaskDetailsModalBody');

    if (!modalTitle || !modalBody) return;

    modalTitle.textContent = task.task_name || 'Scheduled Task';

    modalBody.innerHTML = `
        <div class="row mb-3">
            <div class="col-sm-6"><strong>Status:</strong> ${statusBadge}</div>
            <div class="col-sm-6"><strong>Last Execution:</strong> ${lastExecBadge}</div>
        </div>
        <div class="row mb-3">
            <div class="col-sm-6"><strong>Frequency:</strong> ${escapeHtml(freq)}</div>
            <div class="col-sm-6"><strong>Schedule Time:</strong> ${escapeHtml(scheduleDisplay)}</div>
        </div>
        <div class="row mb-3">
            <div class="col-sm-6"><strong>Last Run:</strong><br>${lastRun}</div>
            <div class="col-sm-6"><strong>Next Run:</strong><br>${nextRun}</div>
        </div>
        <hr>
        <div class="mb-3">
            <strong>Description:</strong>
            <p class="mb-0 mt-1">${escapeHtml(task.task_description || 'No description')}</p>
        </div>
        <div class="mb-3">
            <strong>Automation Prompt / Instructions:</strong>
            <pre class="bg-light p-3 rounded mt-1" style="white-space:pre-wrap; max-height:300px; overflow-y:auto; font-size:0.88rem;">${escapeHtml(task.automation_prompt || 'No prompt')}</pre>
        </div>
    `;

    const modal = new bootstrap.Modal(document.getElementById('scheduledTaskDetailsModal'));
    modal.show();
}

// ============================================================================
// Toast Notification Helper
// ============================================================================

function showToast(message, type = 'info') {
    const bgClass = type === 'success' ? 'bg-success' : type === 'danger' ? 'bg-danger' : type === 'warning' ? 'bg-warning text-dark' : 'bg-primary';
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        container.style.zIndex = '1090';
        document.body.appendChild(container);
    }
    const toastId = 'toast-' + Date.now();
    container.insertAdjacentHTML('beforeend', `
        <div id="${toastId}" class="toast align-items-center text-white ${bgClass} border-0" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
                <div class="toast-body">${message}</div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        </div>
    `);
    const toastEl = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastEl, { delay: 4000 });
    toast.show();
    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatDuration(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${minutes}m ${secs}s`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
}

function formatTimeRemaining(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    } else if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    } else if (minutes > 0) {
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    } else {
        return `${seconds}s`;
    }
}

function startCountdownTimers() {
    // Update all countdown timers every second
    const updateCountdowns = () => {
        const countdownElements = document.querySelectorAll('.countdown');

        countdownElements.forEach(element => {
            const nextRun = new Date(element.dataset.nextRun);
            const now = new Date();
            const timeDiff = nextRun - now;

            if (timeDiff > 0) {
                element.textContent = formatTimeRemaining(timeDiff);
            } else {
                element.textContent = 'Running now...';
                element.style.fontWeight = 'bold';
                element.style.color = '#e74c3c';
            }
        });
    };

    // Clear any existing countdown interval
    if (window.countdownInterval) {
        clearInterval(window.countdownInterval);
    }

    // Update immediately
    updateCountdowns();

    // Update every second
    window.countdownInterval = setInterval(updateCountdowns, 1000);
}

function getExecutionStatusBadge(task) {
    // Status is now derived server-side based on execution lifecycle
    const status = task.last_execution_status || 'pending';

    switch (status) {
        case 'pending':
            return '<span class="badge bg-warning"><i class="bi bi-clock"></i> Pending</span>';
        case 'running':
            return '<span class="badge bg-primary"><i class="bi bi-arrow-repeat"></i> Running</span>';
        case 'paused':
            return '<span class="badge bg-secondary"><i class="bi bi-pause-circle"></i> Paused</span>';
        case 'success':
            return '<span class="badge bg-success"><i class="bi bi-check-circle"></i> Completed</span>';
        case 'failed':
            return '<span class="badge bg-danger"><i class="bi bi-x-circle"></i> Failed</span>';
        case 'canceled':
            return '<span class="badge bg-secondary"><i class="bi bi-x-octagon"></i> Canceled</span>';
        default:
            return '<span class="badge bg-info">Active</span>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getLast7Days() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        days.push(date);
    }
    return days;
}

function getScheduleDescription(frequency, scheduleTime) {
    switch (frequency) {
        case 'once':
            const [date, time] = scheduleTime.split('-').slice(0, 3).join('-') + '-' + scheduleTime.split('-').slice(3).join('-');
            // Parse: "YYYY-MM-DD-HH:MM"
            const parts = scheduleTime.split('-');
            if (parts.length >= 4) {
                const dateStr = `${parts[0]}-${parts[1]}-${parts[2]}`;
                const timeStr = parts.slice(3).join('-');
                const runDate = new Date(dateStr + 'T' + timeStr);
                return `Runs once on ${runDate.toLocaleDateString()} at ${timeStr}`;
            }
            return `Runs once at ${scheduleTime}`;
        case 'daily':
            return `Runs every day at ${scheduleTime}`;
        case 'weekly':
            const [day, weekTime] = scheduleTime.split('-');
            const dayNames = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };
            return `Runs every ${dayNames[day] || day} at ${weekTime}`;
        case 'monthly':
            const [dayNum, monthTime] = scheduleTime.split('-');
            return `Runs on day ${dayNum} of each month at ${monthTime}`;
        case 'hourly':
            return `Runs every hour at minute ${scheduleTime}`;
        default:
            return `Custom schedule: ${scheduleTime}`;
    }
}

function formatScheduleTime(frequency, time, dayOfWeek, date) {
    switch (frequency) {
        case 'once':
            // Format: "YYYY-MM-DD-HH:MM"
            return `${date}-${time}`;
        case 'daily':
        case 'hourly':
            return time;
        case 'weekly':
            return `${dayOfWeek}-${time}`;
        case 'monthly':
            const day = new Date().getDate(); // Default to current day
            return `${String(day).padStart(2, '0')}-${time}`;
        default:
            return time;
    }
}

// ============================================================================
// User Profile Functions
// ============================================================================

function getDefaultAvatar(gender) {
    // Return different colored avatars based on gender
    const colors = {
        male: { bg: '#cce5ff', fg: '#004085' },
        female: { bg: '#f8d7da', fg: '#721c24' },
        other: { bg: '#d4edda', fg: '#155724' }
    };
    const c = colors[gender] || { bg: '#dee2e6', fg: '#6c757d' };

    return `<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="75" cy="75" r="75" fill="${c.bg}"/>
        <circle cx="75" cy="55" r="28" fill="${c.fg}" opacity="0.5"/>
        <ellipse cx="75" cy="130" rx="45" ry="40" fill="${c.fg}" opacity="0.5"/>
    </svg>`;
}

async function fetchUserProfile() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/user/profile`, {
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to fetch profile');

        const result = await response.json();
        if (result.success) {
            const data = result.data;

            // Store user email for WebSocket connection
            currentUserEmail = data.email;

            // Populate form fields
            document.getElementById('profileName').value = data.username || '';
            document.getElementById('profileEmail').value = data.email || '';
            document.getElementById('profileGender').value = data.gender || '';
            document.getElementById('profilePhone').value = data.phone || '';
            document.getElementById('profileCompany').value = data.company || '';

            // Display name and email in sidebar
            document.getElementById('profileDisplayName').textContent = data.username || '-';
            document.getElementById('profileDisplayEmail').textContent = data.email || '-';

            // Handle profile picture
            const imgEl = document.getElementById('profilePictureImg');
            const defaultAvatarEl = document.getElementById('defaultAvatar');
            const deleteOverlay = document.getElementById('deleteAvatarOverlay');

            if (data.profile_picture) {
                imgEl.src = data.profile_picture;
                imgEl.style.display = 'block';
                defaultAvatarEl.style.display = 'none';
                document.getElementById('deleteAvatarOverlay').style.display = '';
            } else {
                imgEl.style.display = 'none';
                defaultAvatarEl.parentElement.innerHTML = getDefaultAvatar(data.gender) +
                    `<img id="profilePictureImg" src="" alt="Profile" style="width: 150px; height: 150px; object-fit: cover; display: none;">`;
                document.getElementById('deleteAvatarOverlay').style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Error fetching user profile:', error);
    }
}

async function updateUserProfile(event) {
    event.preventDefault();

    const btn = document.getElementById('profileSaveBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const payload = {
            username: document.getElementById('profileName').value,
            gender: document.getElementById('profileGender').value || null,
            phone: document.getElementById('profilePhone').value || null,
            company: document.getElementById('profileCompany').value || null
        };

        const response = await fetch(`${API_BASE_URL}/api/user/profile`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.success) {
            // Update displayed name
            document.getElementById('profileDisplayName').textContent = payload.username;

            // Update default avatar if gender changed
            const imgEl = document.getElementById('profilePictureImg');
            if (imgEl && imgEl.style.display === 'none') {
                const container = document.getElementById('profileAvatarContainer');
                const currentImg = container.querySelector('#profilePictureImg');
                container.innerHTML = getDefaultAvatar(payload.gender) +
                    `<img id="profilePictureImg" src="" alt="Profile" style="width: 150px; height: 150px; object-fit: cover; display: none;">`;
            }

            btn.textContent = 'Saved!';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-success');
            setTimeout(() => {
                btn.textContent = originalText;
                btn.classList.remove('btn-success');
                btn.classList.add('btn-primary');
                btn.disabled = false;
            }, 2000);
        } else {
            alert(`Error: ${result.error || result.detail}`);
            btn.textContent = originalText;
            btn.disabled = false;
        }
    } catch (error) {
        console.error('Error updating profile:', error);
        alert(`Error updating profile: ${error.message}`);
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ---- Profile Picture Crop Flow ----

let cropper = null;

function onProfilePictureSelected(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file.');
        return;
    }

    // Validate size (2MB max before crop)
    if (file.size > 5 * 1024 * 1024) {
        alert('Image too large. Please select an image under 5MB.');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const cropImage = document.getElementById('cropImage');
        cropImage.src = e.target.result;

        // Destroy previous cropper if any
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }

        // Show crop modal
        const cropModal = new bootstrap.Modal(document.getElementById('cropModal'));
        cropModal.show();

        // Initialize Cropper.js after modal is shown (so dimensions are correct)
        document.getElementById('cropModal').addEventListener('shown.bs.modal', function initCropper() {
            cropper = new Cropper(cropImage, {
                aspectRatio: 1,
                viewMode: 1,
                dragMode: 'move',
                autoCropArea: 0.9,
                cropBoxResizable: true,
                cropBoxMovable: true,
                guides: true,
                center: true,
                background: false
            });
            // Remove listener after init to avoid duplicate croppers
            document.getElementById('cropModal').removeEventListener('shown.bs.modal', initCropper);
        }, { once: true });
    };
    reader.readAsDataURL(file);

    // Clear input so the same file can be re-selected
    event.target.value = '';
}

async function saveCroppedImage() {
    if (!cropper) return;

    const btn = document.getElementById('cropSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...';

    // Get cropped canvas (output at 300x300 for good avatar quality)
    const canvas = cropper.getCroppedCanvas({
        width: 300,
        height: 300,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
    });

    const base64Data = canvas.toDataURL('image/jpeg', 0.85);

    try {
        const response = await fetch(`${API_BASE_URL}/api/user/profile-picture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ image_data: base64Data })
        });

        const result = await response.json();

        if (result.success) {
            // Update avatar display
            const imgEl = document.getElementById('profilePictureImg');
            const defaultAvatarEl = document.getElementById('profileAvatarContainer').querySelector('svg');

            imgEl.src = base64Data;
            imgEl.style.display = 'block';
            if (defaultAvatarEl) defaultAvatarEl.style.display = 'none';
            document.getElementById('deleteAvatarOverlay').style.display = '';

            // Close crop modal
            bootstrap.Modal.getInstance(document.getElementById('cropModal')).hide();
        } else {
            alert(`Error: ${result.error || result.detail}`);
        }
    } catch (error) {
        console.error('Error uploading profile picture:', error);
        alert(`Error: ${error.message}`);
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-check-lg"></i> Save';
}

// Clean up cropper when modal is hidden
document.addEventListener('DOMContentLoaded', function() {
    const cropModalEl = document.getElementById('cropModal');
    if (cropModalEl) {
        cropModalEl.addEventListener('hidden.bs.modal', function() {
            if (cropper) {
                cropper.destroy();
                cropper = null;
            }
        });
    }
});

// ---- Remove Profile Picture (with confirmation) ----

function confirmRemoveProfilePicture() {
    if (!confirm('Are you sure you want to remove your profile picture?')) {
        return;
    }
    removeProfilePicture();
}

async function removeProfilePicture() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/user/profile-picture`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const result = await response.json();

        if (result.success) {
            const imgEl = document.getElementById('profilePictureImg');
            imgEl.style.display = 'none';
            imgEl.src = '';

            // Restore default avatar immediately
            const gender = document.getElementById('profileGender').value;
            const container = document.getElementById('profileAvatarContainer');
            container.innerHTML = getDefaultAvatar(gender) +
                `<img id="profilePictureImg" src="" alt="Profile" style="width: 150px; height: 150px; object-fit: cover; display: none;">`;

            document.getElementById('deleteAvatarOverlay').style.display = 'none';
        } else {
            alert(`Error: ${result.error || result.detail}`);
        }
    } catch (error) {
        console.error('Error removing profile picture:', error);
        alert(`Error: ${error.message}`);
    }
}

// ---- Profile Picture Lightbox ----

function openProfileLightbox() {
    const imgEl = document.getElementById('profilePictureImg');
    // Only open lightbox if there's an actual profile picture displayed
    if (!imgEl || imgEl.style.display === 'none' || !imgEl.src) return;

    const lightbox = document.getElementById('profileLightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    lightboxImg.src = imgEl.src;
    lightbox.style.display = 'flex';

    // Close on ESC key
    document.addEventListener('keydown', closeLightboxOnEsc);
}

function closeProfileLightbox(event) {
    // Close when clicking backdrop or close button (not the image itself)
    const lightbox = document.getElementById('profileLightbox');
    lightbox.style.display = 'none';
    document.removeEventListener('keydown', closeLightboxOnEsc);
}

function closeLightboxOnEsc(e) {
    if (e.key === 'Escape') {
        closeProfileLightbox();
    }
}

// ============================================================================
// ============================================================================
// Automation History — Erase
// ============================================================================

async function eraseHistory() {
    const btn = document.getElementById('eraseHistoryBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Erasing...';

    if (!confirm('Are you sure you want to erase ALL automation history? This cannot be undone.')) {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-trash3"></i> Erase History';
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/automation/history`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const result = await response.json();

        if (result.success) {
            allHistory = [];
            updateHistoryTable([]);
            updateCharts([]);
            showToast('Automation history erased successfully.', 'success');
        } else {
            showToast(`Error: ${result.error || result.detail}`, 'danger');
        }
    } catch (error) {
        console.error('Error erasing history:', error);
        showToast(`Error: ${error.message}`, 'danger');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-trash3"></i> Erase History';
    }
}

// ============================================================================
// User Settings Functions
// ============================================================================

async function fetchUserSettings() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/user/settings`, {
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to fetch settings');

        const result = await response.json();
        if (result.success) {
            const data = result.data;
            document.getElementById('emailNotif').checked = data.email_notifications;
            document.getElementById('taskNotif').checked = data.task_notifications;
            document.getElementById('errorNotif').checked = data.error_alerts;
        }
    } catch (error) {
        console.error('Error fetching settings:', error);
    }
}

async function saveSettings(event) {
    event.preventDefault();

    const btn = document.getElementById('settingsSaveBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const payload = {
            email_notifications: document.getElementById('emailNotif').checked,
            task_notifications: document.getElementById('taskNotif').checked,
            error_alerts: document.getElementById('errorNotif').checked
        };

        const response = await fetch(`${API_BASE_URL}/api/user/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.success) {
            btn.textContent = 'Saved!';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-success');
            setTimeout(() => {
                btn.textContent = originalText;
                btn.classList.remove('btn-success');
                btn.classList.add('btn-primary');
                btn.disabled = false;
            }, 2000);
        } else {
            alert(`Error: ${result.error || result.detail}`);
            btn.textContent = originalText;
            btn.disabled = false;
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        alert(`Error: ${error.message}`);
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ============================================================================
// Real-time WebSocket Notifications for Scheduled Tasks
// ============================================================================

function connectDashboardWebSocket() {
    if (!currentUserEmail) {
        console.log('⏳ No user email yet, skipping WebSocket connection');
        return;
    }

    // Close existing connection if any
    if (dashboardWs && dashboardWs.readyState <= 1) {
        dashboardWs.close();
    }

    const wsUrl = AGENT_SERVER_URL.replace('http://', 'ws://').replace('https://', 'wss://');
    dashboardWs = new WebSocket(`${wsUrl}/ws/dashboard/${currentUserEmail}`);

    dashboardWs.onopen = () => {
        console.log('📡 Dashboard WebSocket connected');
    };

    dashboardWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleDashboardNotification(data);
        } catch (e) {
            console.error('Error parsing WebSocket message:', e);
        }
    };

    dashboardWs.onclose = () => {
        console.log('📡 Dashboard WebSocket disconnected, reconnecting in 10s...');
        setTimeout(connectDashboardWebSocket, 10000);
    };

    dashboardWs.onerror = (err) => {
        console.error('Dashboard WebSocket error:', err);
    };
}

function handleDashboardNotification(data) {
    console.log('📩 Dashboard notification:', data.type, data);

    if (data.type === 'scheduled_task_started') {
        // Show toast notification
        showDashboardToast(
            `Task "${data.task_name}" has started`,
            'info'
        );

        // Highlight the running task card
        highlightRunningTask(data.task_id);

        // Refresh scheduled tasks list to reflect running status
        fetchScheduledTasks();

    } else if (data.type === 'scheduled_task_completed') {
        const isSuccess = data.status === 'success';
        showDashboardToast(
            `Task "${data.task_name}" ${isSuccess ? 'completed successfully' : 'failed'}`,
            isSuccess ? 'success' : 'danger'
        );

        // Remove pulse animation from completed task
        removeTaskHighlight(data.task_id);

        // Refresh data to reflect updated status
        fetchScheduledTasks();
        fetchAutomationHistory();
        fetchDashboardStats();

    } else if (data.type === 'voice_command_status') {
        // Handle voice command delivery status from agent server
        if (typeof handleVoiceCommandStatus === 'function') {
            handleVoiceCommandStatus(data);
        }
    }
}

function highlightRunningTask(taskId) {
    const card = document.querySelector(`[data-task-id="${taskId}"]`);
    if (card) {
        card.classList.add('scheduled-task-running');
    }
}

function removeTaskHighlight(taskId) {
    const card = document.querySelector(`[data-task-id="${taskId}"]`);
    if (card) {
        card.classList.remove('scheduled-task-running');
    }
}

function showDashboardToast(message, type = 'info') {
    // Create toast container if not exists
    let container = document.getElementById('dashboardToastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'dashboardToastContainer';
        container.style.cssText = 'position:fixed; top:20px; right:20px; z-index:9999; display:flex; flex-direction:column; gap:8px;';
        document.body.appendChild(container);
    }

    const colorMap = {
        info: { bg: '#d1ecf1', border: '#bee5eb', text: '#0c5460', icon: 'bi-info-circle-fill' },
        success: { bg: '#d4edda', border: '#c3e6cb', text: '#155724', icon: 'bi-check-circle-fill' },
        danger: { bg: '#f8d7da', border: '#f5c6cb', text: '#721c24', icon: 'bi-exclamation-triangle-fill' },
        warning: { bg: '#fff3cd', border: '#ffeeba', text: '#856404', icon: 'bi-exclamation-circle-fill' }
    };
    const c = colorMap[type] || colorMap.info;

    const toast = document.createElement('div');
    toast.style.cssText = `
        background:${c.bg}; border:1px solid ${c.border}; color:${c.text};
        padding:12px 18px; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.15);
        font-size:0.9rem; display:flex; align-items:center; gap:10px;
        animation: toastSlideIn 0.3s ease; max-width:400px; min-width:250px;
    `;
    toast.innerHTML = `<i class="bi ${c.icon}" style="font-size:1.1rem;"></i><span>${message}</span>`;

    container.appendChild(toast);

    // Auto-remove after 6 seconds
    setTimeout(() => {
        toast.style.animation = 'toastSlideOut 0.3s ease';
        toast.addEventListener('animationend', () => toast.remove());
    }, 6000);
}

// ============================================================================
// Initialize Dashboard
// ============================================================================

async function initializeDashboard() {
    console.log('🚀 Initializing dynamic dashboard...');

    // Fetch all data including agent health, profile, and settings
    await Promise.all([
        fetchAgentHealth(),
        fetchDashboardStats(),
        fetchAutomationHistory(),
        fetchScheduledTasks(),
        fetchUserProfile(),
        fetchUserSettings()
    ]);

    console.log('✅ Dashboard data loaded');

    // Connect WebSocket for real-time notifications (after profile is loaded)
    connectDashboardWebSocket();

    // Initialize Voice Assistant module
    initVoiceAssistant();

    // Set up auto-refresh every 15 seconds (check agent health more frequently)
    setInterval(async () => {
        await Promise.all([
            fetchAgentHealth(),
            fetchDashboardStats(),
            fetchAutomationHistory(),
            fetchScheduledTasks()
        ]);
    }, 15000); // 15 seconds
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeDashboard);
} else {
    initializeDashboard();
}


// ============================================================================
// Voice Assistant Module — "Hey Geni"
// ============================================================================

// Voice Assistant States
const VA_STATE = {
    DISABLED: 'disabled',
    STANDBY: 'standby',
    ACTIVATED: 'activated',
    PROCESSING: 'processing',
    CONFIRMATION: 'confirmation'
};

let vaState = VA_STATE.DISABLED;
let vaRecognition = null;          // SpeechRecognition for wake word
let vaCommandRecognition = null;   // SpeechRecognition for command capture
let vaCommandText = '';
let vaCommandHistory = [];
let vaWakeDebounce = false;        // Debounce wake word triggers
let vaRestartTimer = null;         // Auto-restart timer for wake word listener
let vaIsRecognitionActive = false; // Track if recognition is currently running
let vaRetryCount = 0;              // Track retries for backoff
const VA_MAX_RETRIES = 5;         // Max consecutive retries before pausing

// Wake word variations for fuzzy matching
const WAKE_PATTERNS = [
    'hey geni', 'hey jenny', 'hey genie', 'hey jeanie', 'hey jeni',
    'hey ginny', 'hey genny', 'a geni', 'hey genius', 'hey gene',
    'he geni', 'hey g', 'hey jenni', 'hey jeannie'
];

function initVoiceAssistant() {
    const toggle = document.getElementById('voiceAssistantToggle');
    if (!toggle) return;

    // Check browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        const unsupported = document.getElementById('voiceUnsupported');
        if (unsupported) unsupported.classList.remove('d-none');
        toggle.disabled = true;
        return;
    }

    toggle.addEventListener('change', () => {
        if (toggle.checked) {
            toggle.nextElementSibling.textContent = 'ON';
            localStorage.setItem('voiceAssistantEnabled', 'true');
            startVoiceAssistant();
        } else {
            toggle.nextElementSibling.textContent = 'OFF';
            localStorage.setItem('voiceAssistantEnabled', 'false');
            stopVoiceAssistant();
        }
    });

    // Restore toggle state from localStorage
    const saved = localStorage.getItem('voiceAssistantEnabled');
    if (saved === 'true') {
        toggle.checked = true;
        toggle.nextElementSibling.textContent = 'ON';
        startVoiceAssistant();
    }

    // Handle page visibility — pause/resume when tab is hidden/shown
    document.addEventListener('visibilitychange', () => {
        if (vaState === VA_STATE.DISABLED) return;
        if (document.hidden) {
            pauseWakeWordListener();
        } else if (vaState === VA_STATE.STANDBY) {
            startWakeWordListener();
        }
    });
}

async function startVoiceAssistant() {
    const card = document.getElementById('voiceAssistantCard');
    if (card) card.classList.remove('disabled-look');

    // Pre-check mic permission before starting
    const hasMic = await checkMicPermission();
    if (!hasMic) {
        showMicDeniedError();
        return;
    }

    hideMicDeniedError();
    vaRetryCount = 0;
    setVoiceState(VA_STATE.STANDBY);

    // Small delay after getUserMedia releases the mic
    setTimeout(() => startWakeWordListener(), 300);
}

function stopVoiceAssistant() {
    // Set state FIRST so onend handlers don't restart
    vaState = VA_STATE.DISABLED;

    pauseWakeWordListener();
    stopCommandCapture();

    const card = document.getElementById('voiceAssistantCard');
    if (card) card.classList.add('disabled-look');

    setVoiceState(VA_STATE.DISABLED);

    // Hide transcript and feedback
    hideElement('voiceTranscriptDisplay');
    hideElement('voiceFeedback');

    // Clear flags
    vaWakeDebounce = false;
    vaIsRecognitionActive = false;
    vaRetryCount = 0;
}

// --- Mic Permission Check ---

async function checkMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop()); // Release immediately
        return true;
    } catch (err) {
        console.warn('[VA] getUserMedia check failed:', err.name, err.message);
        return false;
    }
}

function showMicDeniedError() {
    const micError = document.getElementById('voiceMicError');
    if (micError) micError.classList.remove('d-none');
    stopVoiceAssistant();
    const toggle = document.getElementById('voiceAssistantToggle');
    if (toggle) {
        toggle.checked = false;
        toggle.nextElementSibling.textContent = 'OFF';
    }
    localStorage.setItem('voiceAssistantEnabled', 'false');
}

function hideMicDeniedError() {
    const micError = document.getElementById('voiceMicError');
    if (micError) micError.classList.add('d-none');
}

// --- Wake Word Listener ---

function startWakeWordListener() {
    // Clean up any existing instance
    if (vaRecognition) {
        try { vaRecognition.abort(); } catch(e) {}
        vaRecognition = null;
    }
    vaIsRecognitionActive = false;
    if (vaRestartTimer) {
        clearTimeout(vaRestartTimer);
        vaRestartTimer = null;
    }

    // Don't start if not in standby
    if (vaState !== VA_STATE.STANDBY) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    vaRecognition = new SpeechRecognition();
    vaRecognition.continuous = true;
    vaRecognition.interimResults = true;
    vaRecognition.lang = 'en-US';
    vaRecognition.maxAlternatives = 3;

    vaRecognition.onstart = () => {
        vaIsRecognitionActive = true;
        vaRetryCount = 0; // Reset retries on successful start
        hideMicDeniedError(); // Clear any stale error
        console.log('[VA] Wake word listener active — mic is live');
    };

    vaRecognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            // Check all alternatives for better matching
            for (let alt = 0; alt < event.results[i].length; alt++) {
                const transcript = event.results[i][alt].transcript.toLowerCase().trim();
                console.log('[VA] Heard:', transcript);
                if (matchesWakeWord(transcript)) {
                    if (!vaWakeDebounce) {
                        vaWakeDebounce = true;
                        setTimeout(() => { vaWakeDebounce = false; }, 3000);
                        onWakeWordDetected();
                    }
                    return;
                }
            }
        }
    };

    vaRecognition.onerror = (event) => {
        console.log('[VA] Wake listener error:', event.error);

        switch (event.error) {
            case 'not-allowed':
            case 'service-not-allowed':
                // Don't trust this blindly — verify with getUserMedia
                checkMicPermission().then(hasAccess => {
                    if (!hasAccess) {
                        // Mic is actually denied
                        console.error('[VA] Mic permission truly denied');
                        showMicDeniedError();
                    } else {
                        // False alarm (CDP interference, tab switch, etc.) — retry
                        console.warn('[VA] Got not-allowed but mic is accessible — retrying');
                        scheduleWakeRestart(500);
                    }
                });
                break;

            case 'no-speech':
                // Normal — silence timeout, just let onend restart
                console.log('[VA] No speech detected — will auto-restart');
                break;

            case 'aborted':
                // We called .abort() or browser interrupted — let onend handle
                console.log('[VA] Recognition aborted');
                break;

            case 'audio-capture':
                // Mic is in use by another app
                console.warn('[VA] Mic in use by another app — retrying in 2s');
                scheduleWakeRestart(2000);
                break;

            case 'network':
                console.warn('[VA] Network error — retrying in 1s');
                scheduleWakeRestart(1000);
                break;

            default:
                console.warn('[VA] Unknown error:', event.error, '— retrying');
                scheduleWakeRestart(1000);
                break;
        }
    };

    vaRecognition.onend = () => {
        vaIsRecognitionActive = false;
        console.log('[VA] Wake listener ended, state:', vaState);
        // Auto-restart if we should still be listening
        if (vaState === VA_STATE.STANDBY && !document.hidden) {
            scheduleWakeRestart(300);
        }
    };

    try {
        vaRecognition.start();
        console.log('[VA] Wake word listener started');
    } catch(e) {
        vaIsRecognitionActive = false;
        console.warn('[VA] Could not start wake listener:', e.message);
        scheduleWakeRestart(1000);
    }
}

function scheduleWakeRestart(delay) {
    if (vaRestartTimer) clearTimeout(vaRestartTimer);
    if (vaState !== VA_STATE.STANDBY || document.hidden) return;

    vaRetryCount++;
    if (vaRetryCount > VA_MAX_RETRIES) {
        // Back off — wait longer, then reset count
        console.warn(`[VA] ${VA_MAX_RETRIES} consecutive retries, backing off 5s...`);
        vaRetryCount = 0;
        delay = 5000;
    }

    vaRestartTimer = setTimeout(() => {
        if (vaState === VA_STATE.STANDBY && !document.hidden) {
            console.log('[VA] Scheduled restart, attempt', vaRetryCount);
            startWakeWordListener();
        }
    }, delay);
}

function pauseWakeWordListener() {
    if (vaRestartTimer) {
        clearTimeout(vaRestartTimer);
        vaRestartTimer = null;
    }
    if (vaRecognition) {
        try { vaRecognition.abort(); } catch(e) {}
        vaRecognition = null;
    }
    vaIsRecognitionActive = false;
}

function matchesWakeWord(transcript) {
    const cleaned = transcript.replace(/[^a-z\s]/g, '').trim();
    for (const pattern of WAKE_PATTERNS) {
        if (cleaned.includes(pattern)) return true;
    }
    // Additional fuzzy: check if last few words match
    const words = cleaned.split(/\s+/);
    const tail = words.slice(-3).join(' ');
    for (const pattern of WAKE_PATTERNS) {
        if (tail.includes(pattern)) return true;
    }
    return false;
}

// --- Wake Word Detected ---

function onWakeWordDetected() {
    console.log('[VA] Wake word detected!');
    pauseWakeWordListener();
    playActivationSound();
    setVoiceState(VA_STATE.ACTIVATED);

    // Hide old feedback
    hideElement('voiceFeedback');

    // Start command capture
    startCommandCapture();
}

function playActivationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
    } catch(e) {
        // Audio context not available, skip sound
    }
}

// --- Command Capture ---

function startCommandCapture() {
    vaCommandText = '';
    const transcriptDisplay = document.getElementById('voiceTranscriptDisplay');
    const transcriptText = document.getElementById('voiceTranscriptText');
    if (transcriptDisplay) transcriptDisplay.style.display = 'block';
    if (transcriptText) transcriptText.textContent = 'Listening...';

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    vaCommandRecognition = new SpeechRecognition();
    vaCommandRecognition.continuous = false;
    vaCommandRecognition.interimResults = true;
    vaCommandRecognition.lang = 'en-US';

    let silenceTimer = null;

    vaCommandRecognition.onresult = (event) => {
        let finalText = '';
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalText += t + ' ';
            } else {
                interimText += t;
            }
        }
        if (finalText) vaCommandText += finalText;

        // Update live transcript
        if (transcriptText) {
            transcriptText.textContent = (vaCommandText + interimText).trim() || 'Listening...';
        }

        // Reset silence timer on each result
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (vaCommandRecognition) {
                try { vaCommandRecognition.stop(); } catch(e) {}
            }
        }, 2000);
    };

    vaCommandRecognition.onerror = (event) => {
        console.log('[VA] Command capture error:', event.error);
        if (event.error === 'no-speech') {
            // Timeout — no speech after activation
            if (transcriptText) transcriptText.textContent = 'No speech detected';
            setTimeout(() => {
                setVoiceState(VA_STATE.STANDBY);
                hideElement('voiceTranscriptDisplay');
                startWakeWordListener();
            }, 1500);
            return;
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            // Verify with getUserMedia before showing error
            checkMicPermission().then(hasAccess => {
                if (!hasAccess) {
                    showMicDeniedError();
                } else {
                    // Transient — go back to standby
                    console.warn('[VA] Command capture got not-allowed but mic is fine — returning to standby');
                    setVoiceState(VA_STATE.STANDBY);
                    hideElement('voiceTranscriptDisplay');
                    startWakeWordListener();
                }
            });
            return;
        }
        // For other errors (aborted, audio-capture, network) — return to standby
        setVoiceState(VA_STATE.STANDBY);
        hideElement('voiceTranscriptDisplay');
        startWakeWordListener();
    };

    vaCommandRecognition.onend = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        const command = vaCommandText.trim();
        if (command) {
            processVoiceCommand(command);
        } else {
            // No text captured
            if (transcriptText) transcriptText.textContent = 'No speech detected';
            setTimeout(() => {
                setVoiceState(VA_STATE.STANDBY);
                hideElement('voiceTranscriptDisplay');
                startWakeWordListener();
            }, 1500);
        }
    };

    try {
        vaCommandRecognition.start();
        console.log('[VA] Command capture started');
    } catch(e) {
        console.warn('[VA] Could not start command capture:', e);
        setVoiceState(VA_STATE.STANDBY);
        startWakeWordListener();
    }
}

function stopCommandCapture() {
    if (vaCommandRecognition) {
        try { vaCommandRecognition.abort(); } catch(e) {}
        vaCommandRecognition = null;
    }
}

// --- Process & Send Command ---

function processVoiceCommand(command) {
    console.log('[VA] Processing command:', command);
    setVoiceState(VA_STATE.PROCESSING);

    const transcriptText = document.getElementById('voiceTranscriptText');
    if (transcriptText) transcriptText.textContent = command;

    // Send via dashboard WebSocket
    if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
        dashboardWs.send(JSON.stringify({
            type: 'voice_command',
            command: command
        }));

        // Optimistically show as sent — will be confirmed by server response
        addVoiceCommandToHistory(command, 'sent');
        showVoiceFeedback('success', `Command sent: "${command.substring(0, 60)}${command.length > 60 ? '...' : ''}"`);
    } else {
        addVoiceCommandToHistory(command, 'failed');
        showVoiceFeedback('error', 'Not connected to server. Please refresh the page.');
    }

    // Return to standby after brief delay
    setTimeout(() => {
        setVoiceState(VA_STATE.STANDBY);
        hideElement('voiceTranscriptDisplay');
        startWakeWordListener();
    }, 3000);
}

function handleVoiceCommandStatus(data) {
    if (data.status === 'error') {
        showVoiceFeedback('error', data.message || 'Failed to send command');
        // Update last history item
        const items = document.querySelectorAll('.voice-history-status');
        if (items.length > 0) {
            const last = items[0];
            last.textContent = 'Failed';
            last.className = 'voice-history-status failed';
        }
    }
}

// --- UI Helpers ---

function setVoiceState(newState) {
    vaState = newState;
    const orb = document.getElementById('voiceOrb');
    const statusText = document.getElementById('voiceStatusText');
    const statusHint = document.getElementById('voiceStatusHint');

    if (!orb) return;

    // Remove all state classes
    orb.className = 'voice-orb ' + newState;

    switch (newState) {
        case VA_STATE.DISABLED:
            if (statusText) statusText.textContent = 'Disabled';
            if (statusHint) statusHint.textContent = 'Turn on the toggle to start';
            break;
        case VA_STATE.STANDBY:
            if (statusText) statusText.textContent = 'Listening...';
            if (statusHint) statusHint.textContent = 'Say "Hey Geni" to activate';
            break;
        case VA_STATE.ACTIVATED:
            if (statusText) statusText.textContent = 'Speak now';
            if (statusHint) statusHint.textContent = 'Tell me what you want to automate';
            break;
        case VA_STATE.PROCESSING:
            if (statusText) statusText.textContent = 'Processing...';
            if (statusHint) statusHint.textContent = 'Sending your command';
            break;
        case VA_STATE.CONFIRMATION:
            if (statusText) statusText.textContent = 'Done';
            if (statusHint) statusHint.textContent = '';
            break;
    }
}

function showVoiceFeedback(type, message) {
    const fb = document.getElementById('voiceFeedback');
    const icon = document.getElementById('voiceFeedbackIcon');
    const msg = document.getElementById('voiceFeedbackMessage');
    if (!fb) return;

    fb.className = 'voice-feedback ' + type;
    fb.style.display = 'flex';

    if (icon) {
        icon.className = type === 'success'
            ? 'bi bi-check-circle-fill voice-feedback-icon'
            : 'bi bi-exclamation-circle-fill voice-feedback-icon';
    }
    if (msg) msg.textContent = message;

    // Auto-hide after 5 seconds
    setTimeout(() => { hideElement('voiceFeedback'); }, 5000);
}

function addVoiceCommandToHistory(command, status) {
    const entry = {
        command: command,
        status: status,
        timestamp: new Date()
    };
    vaCommandHistory.unshift(entry);
    if (vaCommandHistory.length > 20) vaCommandHistory.pop();

    renderVoiceCommandHistory();
}

function renderVoiceCommandHistory() {
    const container = document.getElementById('voiceCommandHistory');
    const eraseBtn = document.getElementById('eraseVoiceHistoryBtn');
    if (!container) return;

    if (vaCommandHistory.length === 0) {
        container.innerHTML = '<div class="list-group-item text-center text-muted">No voice commands yet</div>';
        if (eraseBtn) eraseBtn.disabled = true;
        return;
    }

    if (eraseBtn) eraseBtn.disabled = false;

    container.innerHTML = vaCommandHistory.slice(0, 10).map(entry => {
        const timeStr = entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = entry.timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `
            <div class="list-group-item voice-history-item">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="voice-history-command">${escapeHtml(entry.command)}</div>
                    <span class="voice-history-status ${entry.status}">${entry.status === 'sent' ? 'Sent' : 'Failed'}</span>
                </div>
                <div class="voice-history-meta">${dateStr} at ${timeStr}</div>
            </div>
        `;
    }).join('');
}

function eraseVoiceHistory() {
    if (vaCommandHistory.length === 0) return;

    if (!confirm('Are you sure you want to erase all voice command history?')) {
        return;
    }

    vaCommandHistory = [];
    renderVoiceCommandHistory();
    showToast('Voice command history cleared.', 'success');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function hideElement(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}
