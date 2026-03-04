// ========================================
// AUTHENTICATION JAVASCRIPT
// Handles form validation, submission, and UI interactions
// ========================================

(function() {
    'use strict';

    // ========================================
    // UTILITY FUNCTIONS
    // ========================================

    /**
     * Email validation using regex
     * @param {string} email - Email address to validate
     * @returns {boolean} - True if valid email
     */
    function isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Password strength checker
     * @param {string} password - Password to check
     * @returns {object} - Strength level and score
     */
    function checkPasswordStrength(password) {
        let strength = 0;
        let level = '';

        if (password.length >= 8) strength++;
        if (password.length >= 12) strength++;
        if (/[a-z]/.test(password)) strength++;
        if (/[A-Z]/.test(password)) strength++;
        if (/[0-9]/.test(password)) strength++;
        if (/[^a-zA-Z0-9]/.test(password)) strength++;

        if (strength <= 2) {
            level = 'weak';
        } else if (strength <= 4) {
            level = 'medium';
        } else {
            level = 'strong';
        }

        return { level, strength };
    }

    /**
     * Show error message for a field
     * @param {string} fieldId - ID of the input field
     * @param {string} errorId - ID of the error message element
     * @param {string} message - Error message to display
     */
    function showError(fieldId, errorId, message) {
        const field = document.getElementById(fieldId);
        const errorElement = document.getElementById(errorId);

        if (field && errorElement) {
            field.classList.add('error');
            field.classList.remove('success');
            errorElement.textContent = message;
            errorElement.classList.add('show');
        }
    }

    /**
     * Clear error message for a field
     * @param {string} fieldId - ID of the input field
     * @param {string} errorId - ID of the error message element
     */
    function clearError(fieldId, errorId) {
        const field = document.getElementById(fieldId);
        const errorElement = document.getElementById(errorId);

        if (field && errorElement) {
            field.classList.remove('error');
            field.classList.add('success');
            errorElement.textContent = '';
            errorElement.classList.remove('show');
        }
    }

    /**
     * Show general error message
     * @param {string} message - Error message to display
     */
    function showGeneralError(message) {
        const errorElement = document.getElementById('generalError');
        if (errorElement) {
            // Ensure message is a string
            let displayMessage = message;
            if (typeof message !== 'string') {
                // Try to extract message from object
                if (message && message.message) {
                    displayMessage = message.message;
                } else if (message && message.detail) {
                    displayMessage = message.detail;
                } else {
                    displayMessage = 'An error occurred. Please try again.';
                }
            }

            errorElement.textContent = displayMessage;
            errorElement.style.display = 'block';

            // Shake animation
            errorElement.classList.add('shake');
            setTimeout(() => errorElement.classList.remove('shake'), 500);
        }
    }

    /**
     * Hide general error message
     */
    function hideGeneralError() {
        const errorElement = document.getElementById('generalError');
        if (errorElement) {
            errorElement.style.display = 'none';
        }
    }

    /**
     * Toggle button loading state
     * @param {HTMLElement} button - Button element
     * @param {boolean} loading - True to show loading state
     */
    function setButtonLoading(button, loading) {
        const btnText = button.querySelector('.btn-text');
        const btnLoader = button.querySelector('.btn-loader');

        if (loading) {
            button.disabled = true;
            btnText.style.display = 'none';
            btnLoader.style.display = 'inline-flex';
        } else {
            button.disabled = false;
            btnText.style.display = 'inline';
            btnLoader.style.display = 'none';
        }
    }

    // ========================================
    // PASSWORD TOGGLE FUNCTIONALITY
    // ========================================

    /**
     * Initialize password toggle buttons
     */
    function initPasswordToggle() {
        const toggleButtons = document.querySelectorAll('.toggle-password');

        toggleButtons.forEach(button => {
            button.addEventListener('click', function() {
                const targetId = this.getAttribute('data-target');
                const passwordField = document.getElementById(targetId);
                const icon = this.querySelector('i');

                if (passwordField) {
                    if (passwordField.type === 'password') {
                        passwordField.type = 'text';
                        icon.classList.remove('fa-eye');
                        icon.classList.add('fa-eye-slash');
                    } else {
                        passwordField.type = 'password';
                        icon.classList.remove('fa-eye-slash');
                        icon.classList.add('fa-eye');
                    }
                }
            });
        });
    }

    // ========================================
    // LOGIN FORM HANDLING
    // ========================================

    /**
     * Initialize login form
     */
    function initLoginForm() {
        const loginForm = document.getElementById('loginForm');
        if (!loginForm) return;

        const emailField = document.getElementById('loginEmail');
        const passwordField = document.getElementById('loginPassword');

        // Real-time validation
        if (emailField) {
            emailField.addEventListener('blur', function() {
                if (this.value.trim() === '') {
                    showError('loginEmail', 'emailError', 'Email is required');
                } else if (!isValidEmail(this.value)) {
                    showError('loginEmail', 'emailError', 'Please enter a valid email address');
                } else {
                    clearError('loginEmail', 'emailError');
                }
            });

            emailField.addEventListener('input', function() {
                if (this.value.trim() !== '') {
                    hideGeneralError();
                }
            });
        }

        if (passwordField) {
            passwordField.addEventListener('blur', function() {
                if (this.value === '') {
                    showError('loginPassword', 'passwordError', 'Password is required');
                } else {
                    clearError('loginPassword', 'passwordError');
                }
            });

            passwordField.addEventListener('input', function() {
                if (this.value !== '') {
                    hideGeneralError();
                }
            });
        }

        // Form submission
        loginForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            hideGeneralError();

            const email = emailField.value.trim();
            const password = passwordField.value;
            let isValid = true;

            // Validate email
            if (email === '') {
                showError('loginEmail', 'emailError', 'Email is required');
                isValid = false;
            } else if (!isValidEmail(email)) {
                showError('loginEmail', 'emailError', 'Please enter a valid email address');
                isValid = false;
            } else {
                clearError('loginEmail', 'emailError');
            }

            // Validate password
            if (password === '') {
                showError('loginPassword', 'passwordError', 'Password is required');
                isValid = false;
            } else {
                clearError('loginPassword', 'passwordError');
            }

            if (!isValid) return;

            // Submit form
            const submitBtn = this.querySelector('.submit-btn');
            setButtonLoading(submitBtn, true);

            try {
                // Placeholder for API call
                const response = await loginUser(email, password);

                // Success handling
                console.log('Login successful:', response);

                // Redirect to dashboard
                window.location.href = '/dashboard.html';

            } catch (error) {
                // Error handling
                setButtonLoading(submitBtn, false);

                // Convert error to string properly
                let errorMessage = 'Login failed. Please check your credentials and try again.';
                if (error && error.message) {
                    errorMessage = error.message;
                } else if (typeof error === 'string') {
                    errorMessage = error;
                } else if (error && error.detail) {
                    errorMessage = error.detail;
                }

                console.error('Login error:', errorMessage);
                showGeneralError(errorMessage);
            }
        });
    }

    /**
     * Login API call
     * @param {string} email - User email
     * @param {string} password - User password
     * @returns {Promise} - API response
     */
    async function loginUser(email, password) {
        try {
            const response = await fetch('http://localhost:8000/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password }),
            });

            // Get response text first
            const text = await response.text();

            // Try to parse as JSON
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                // If parsing fails, it's likely an HTML error page
                console.error('Server response:', text);
                throw new Error('Server error: ' + (text.substring(0, 100) || 'Unknown error'));
            }

            if (!response.ok) {
                throw new Error(data.detail || data.message || 'Login failed');
            }

            // Store token and user info
            localStorage.setItem('authToken', data.access_token);
            localStorage.setItem('user', JSON.stringify(data.user));

            return data;
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    }

    // ========================================
    // SIGNUP FORM HANDLING
    // ========================================

    /**
     * Initialize signup form
     */
    function initSignupForm() {
        const signupForm = document.getElementById('signupForm');
        if (!signupForm) return;

        const nameField = document.getElementById('signupName');
        const emailField = document.getElementById('signupEmail');
        const passwordField = document.getElementById('signupPassword');
        const confirmPasswordField = document.getElementById('confirmPassword');
        const termsCheckbox = document.getElementById('agreeTerms');
        const passwordStrength = document.getElementById('passwordStrength');

        // Name validation
        if (nameField) {
            nameField.addEventListener('blur', function() {
                if (this.value.trim() === '') {
                    showError('signupName', 'nameError', 'Full name is required');
                } else if (this.value.trim().length < 2) {
                    showError('signupName', 'nameError', 'Name must be at least 2 characters');
                } else {
                    clearError('signupName', 'nameError');
                }
            });
        }

        // Email validation
        if (emailField) {
            emailField.addEventListener('blur', function() {
                if (this.value.trim() === '') {
                    showError('signupEmail', 'emailError', 'Email is required');
                } else if (!isValidEmail(this.value)) {
                    showError('signupEmail', 'emailError', 'Please enter a valid email address');
                } else {
                    clearError('signupEmail', 'emailError');
                }
            });
        }

        // Password validation with strength indicator
        if (passwordField && passwordStrength) {
            passwordField.addEventListener('input', function() {
                const password = this.value;

                // Check password length limits
                if (password.length > 128) {
                    showError('signupPassword', 'passwordError', 'Password cannot exceed 128 characters');
                    return;
                }

                if (password.length > 0) {
                    const { level, strength } = checkPasswordStrength(password);

                    passwordStrength.className = 'password-strength ' + level;

                    if (level === 'weak') {
                        passwordStrength.textContent = '⚠ Weak password - Consider adding more characters';
                    } else if (level === 'medium') {
                        passwordStrength.textContent = '✓ Medium password';
                    } else {
                        passwordStrength.textContent = '✓ Strong password';
                    }
                } else {
                    passwordStrength.className = 'password-strength';
                    passwordStrength.textContent = '';
                }
            });

            passwordField.addEventListener('blur', function() {
                if (this.value === '') {
                    showError('signupPassword', 'passwordError', 'Password is required');
                } else if (this.value.length < 8) {
                    showError('signupPassword', 'passwordError', 'Password must be at least 8 characters');
                } else if (this.value.length > 128) {
                    showError('signupPassword', 'passwordError', 'Password cannot exceed 128 characters');
                } else {
                    clearError('signupPassword', 'passwordError');
                }
            });
        }

        // Confirm password validation
        if (confirmPasswordField) {
            confirmPasswordField.addEventListener('blur', function() {
                if (this.value === '') {
                    showError('confirmPassword', 'confirmPasswordError', 'Please confirm your password');
                } else if (this.value !== passwordField.value) {
                    showError('confirmPassword', 'confirmPasswordError', 'Passwords do not match');
                } else {
                    clearError('confirmPassword', 'confirmPasswordError');
                }
            });
        }

        // Form submission
        signupForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            hideGeneralError();

            const name = nameField.value.trim();
            const email = emailField.value.trim();
            const password = passwordField.value;
            const confirmPassword = confirmPasswordField.value;
            const agreeToTerms = termsCheckbox.checked;
            let isValid = true;

            // Validate name
            if (name === '') {
                showError('signupName', 'nameError', 'Full name is required');
                isValid = false;
            } else if (name.length < 2) {
                showError('signupName', 'nameError', 'Name must be at least 2 characters');
                isValid = false;
            } else {
                clearError('signupName', 'nameError');
            }

            // Validate email
            if (email === '') {
                showError('signupEmail', 'emailError', 'Email is required');
                isValid = false;
            } else if (!isValidEmail(email)) {
                showError('signupEmail', 'emailError', 'Please enter a valid email address');
                isValid = false;
            } else {
                clearError('signupEmail', 'emailError');
            }

            // Validate password
            if (password === '') {
                showError('signupPassword', 'passwordError', 'Password is required');
                isValid = false;
            } else if (password.length < 8) {
                showError('signupPassword', 'passwordError', 'Password must be at least 8 characters');
                isValid = false;
            } else if (password.length > 128) {
                showError('signupPassword', 'passwordError', 'Password cannot exceed 128 characters');
                isValid = false;
            } else {
                clearError('signupPassword', 'passwordError');
            }

            // Validate confirm password
            if (confirmPassword === '') {
                showError('confirmPassword', 'confirmPasswordError', 'Please confirm your password');
                isValid = false;
            } else if (confirmPassword !== password) {
                showError('confirmPassword', 'confirmPasswordError', 'Passwords do not match');
                isValid = false;
            } else {
                clearError('confirmPassword', 'confirmPasswordError');
            }

            // Validate terms
            if (!agreeToTerms) {
                showError('agreeTerms', 'termsError', 'You must agree to the Terms & Conditions');
                isValid = false;
            } else {
                clearError('agreeTerms', 'termsError');
            }

            if (!isValid) return;

            // Submit form
            const submitBtn = this.querySelector('.submit-btn');
            setButtonLoading(submitBtn, true);

            try {
                // Call signup API
                const response = await signupUser(name, email, password);

                // Success handling
                console.log('Signup successful:', response);

                // Check if email verification is required
                if (response.verification_required) {
                    console.log('Email verification required, showing modal');
                    setButtonLoading(submitBtn, false);

                    // Show verification modal
                    window.showVerificationModal(response.email || email);
                } else {
                    // No verification needed, redirect to dashboard
                    console.log('No verification required, redirecting to dashboard');
                    window.location.href = '/dashboard';
                }

            } catch (error) {
                // Error handling
                setButtonLoading(submitBtn, false);

                // Convert error to string properly
                let errorMessage = 'Signup failed. Please try again.';
                if (error && error.message) {
                    errorMessage = error.message;
                } else if (typeof error === 'string') {
                    errorMessage = error;
                } else if (error && error.detail) {
                    errorMessage = error.detail;
                }

                console.error('Signup error:', errorMessage);
                showGeneralError(errorMessage);
            }
        });
    }

    /**
     * Signup API call
     * @param {string} name - User full name
     * @param {string} email - User email
     * @param {string} password - User password
     * @returns {Promise} - API response
     */
    async function signupUser(name, email, password) {
        try {
            const response = await fetch('http://localhost:8000/api/signup', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    username: name,
                    email,
                    password
                }),
            });

            // Get response text first
            const text = await response.text();

            // Try to parse as JSON
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                // If parsing fails, it's likely an HTML error page
                console.error('Server response:', text);
                throw new Error('Server error: ' + (text.substring(0, 100) || 'Unknown error'));
            }

            if (!response.ok) {
                throw new Error(data.detail || data.message || 'Signup failed');
            }

            // Store token and user info
            localStorage.setItem('authToken', data.access_token);
            localStorage.setItem('user', JSON.stringify(data.user));

            return data;
        } catch (error) {
            console.error('Signup error:', error);
            throw error;
        }
    }

    // ========================================
    // GOOGLE LOGIN HANDLING
    // ========================================

    /**
     * Initialize Google login buttons
     */
    function initGoogleLogin() {
        const googleLoginBtn = document.getElementById('googleLoginBtn');
        const googleSignupBtn = document.getElementById('googleSignupBtn');

        if (googleLoginBtn) {
            googleLoginBtn.addEventListener('click', handleGoogleAuth);
        }

        if (googleSignupBtn) {
            googleSignupBtn.addEventListener('click', handleGoogleAuth);
        }
    }

    /**
     * Handle Google authentication
     */
    async function handleGoogleAuth() {
        try {
            // Get Client ID from meta tag
            const clientId = document.querySelector('meta[name="google-client-id"]')?.content || '265869413628-8a9rlgem2m7p8qlith3d9bel2vkru8vu.apps.googleusercontent.com';

            // Initialize Google Sign-In
            google.accounts.id.initialize({
                client_id: clientId,
                callback: async (response) => {
                    try {
                        // Send credential to backend
                        const result = await fetch('/api/auth/google', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                credential: response.credential
                            }),
                        });

                        const data = await result.json();

                        if (data.success) {
                            // Redirect to dashboard
                            window.location.href = data.redirect || '/dashboard';
                        } else {
                            throw new Error(data.error || 'Google authentication failed');
                        }
                    } catch (error) {
                        console.error('Google auth error:', error);
                        showGeneralError(error.message || 'Failed to authenticate with Google');
                    }
                }
            });

            // Trigger the sign-in flow
            google.accounts.id.prompt();

        } catch (error) {
            console.error('Google authentication failed:', error);
            showGeneralError('Google sign-in failed. Please try again.');
        }
    }

    // ========================================
    // EMAIL VERIFICATION MODAL
    // ========================================

    /**
     * Show verification modal
     * @param {string} email - User email that needs verification
     */
    window.showVerificationModal = function(email) {
        const modal = document.getElementById('verificationModal');
        const emailDisplay = document.getElementById('verificationEmail');
        const codeInputs = document.querySelectorAll('.code-input');
        const verifyBtn = document.getElementById('verifyCodeBtn');
        const resendBtn = document.getElementById('resendCodeBtn');
        const errorDiv = document.getElementById('verificationError');

        if (!modal) return;

        // Set email display
        if (emailDisplay) {
            emailDisplay.textContent = email;
        }

        // Show modal
        modal.style.display = 'flex';

        // Clear any existing values
        codeInputs.forEach(input => {
            input.value = '';
        });

        // Focus first input
        if (codeInputs[0]) {
            codeInputs[0].focus();
        }

        // Handle code input navigation
        codeInputs.forEach((input, index) => {
            input.addEventListener('input', function(e) {
                const value = e.target.value;

                // Only allow digits
                if (!/^\d$/.test(value)) {
                    e.target.value = '';
                    return;
                }

                // Move to next input
                if (value && index < codeInputs.length - 1) {
                    codeInputs[index + 1].focus();
                }
            });

            input.addEventListener('keydown', function(e) {
                // Handle backspace
                if (e.key === 'Backspace' && !input.value && index > 0) {
                    codeInputs[index - 1].focus();
                }

                // Handle paste
                if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    navigator.clipboard.readText().then(text => {
                        const digits = text.replace(/\D/g, '').slice(0, 6);
                        digits.split('').forEach((digit, i) => {
                            if (codeInputs[i]) {
                                codeInputs[i].value = digit;
                            }
                        });
                        if (digits.length === 6) {
                            verifyBtn.focus();
                        }
                    });
                }
            });
        });

        // Handle verify button
        if (verifyBtn) {
            verifyBtn.addEventListener('click', async function() {
                // Get code from inputs
                const code = Array.from(codeInputs).map(input => input.value).join('');

                if (code.length !== 6) {
                    showVerificationError('Please enter all 6 digits');
                    return;
                }

                // Show loading
                const btnText = verifyBtn.querySelector('.btn-text');
                const btnLoader = verifyBtn.querySelector('.btn-loader');
                btnText.style.display = 'none';
                btnLoader.style.display = 'inline-flex';
                verifyBtn.disabled = true;
                codeInputs.forEach(input => input.disabled = true);

                try {
                    const response = await fetch('/api/verify-email', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            email: email,
                            code: code
                        })
                    });

                    const data = await response.json();

                    if (data.success) {
                        // Verification successful
                        modal.style.display = 'none';
                        if (data.redirect) {
                            window.location.href = data.redirect;
                        }
                    } else {
                        showVerificationError(data.error || 'Invalid verification code');
                        btnText.style.display = 'inline';
                        btnLoader.style.display = 'none';
                        verifyBtn.disabled = false;
                        codeInputs.forEach(input => {
                            input.disabled = false;
                            input.value = '';
                        });
                        codeInputs[0].focus();
                    }
                } catch (error) {
                    showVerificationError('Network error. Please try again.');
                    btnText.style.display = 'inline';
                    btnLoader.style.display = 'none';
                    verifyBtn.disabled = false;
                    codeInputs.forEach(input => input.disabled = false);
                }
            });
        }

        // Handle resend button
        if (resendBtn) {
            resendBtn.addEventListener('click', async function() {
                resendBtn.disabled = true;
                resendBtn.textContent = 'Sending...';

                try {
                    const response = await fetch('/api/resend-verification', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ email: email })
                    });

                    const data = await response.json();

                    if (data.success) {
                        resendBtn.textContent = 'Code Sent!';
                        setTimeout(() => {
                            resendBtn.textContent = 'Resend Code';
                            resendBtn.disabled = false;
                        }, 3000);
                    } else {
                        resendBtn.textContent = 'Resend Code';
                        resendBtn.disabled = false;
                        showVerificationError(data.error || 'Failed to resend code');
                    }
                } catch (error) {
                    resendBtn.textContent = 'Resend Code';
                    resendBtn.disabled = false;
                    showVerificationError('Network error. Please try again.');
                }
            });
        }
    };

    /**
     * Show verification error message
     * @param {string} message - Error message to display
     */
    function showVerificationError(message) {
        const errorDiv = document.getElementById('verificationError');
        if (errorDiv) {
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';

            setTimeout(() => {
                errorDiv.style.display = 'none';
            }, 5000);
        }
    }

    // ========================================
    // GOOGLE OAUTH INTEGRATION
    // ========================================

    /**
     * Handle Google OAuth credential response
     * @param {object} response - Google OAuth response
     */
    window.handleGoogleCallback = async function(response) {
        try {
            const result = await fetch('/api/auth/google', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    credential: response.credential
                })
            });

            const data = await result.json();

            if (data.success) {
                // Redirect to dashboard
                window.location.href = data.redirect || '/dashboard';
            } else {
                showGeneralError(data.error || 'Google authentication failed');
            }
        } catch (error) {
            showGeneralError('Network error during Google authentication');
        }
    };

    /**
     * Initialize Google Sign-In
     */
    function initGoogleSignIn() {
        // This will be called when Google SDK loads
        if (typeof google !== 'undefined') {
            const clientId = document.querySelector('meta[name="google-client-id"]')?.content || '265869413628-8a9rlgem2m7p8qlith3d9bel2vkru8vu.apps.googleusercontent.com';
            google.accounts.id.initialize({
                client_id: clientId,
                callback: window.handleGoogleCallback
            });
        }
    }

    // Listen for Google SDK load
    window.addEventListener('load', function() {
        if (typeof google !== 'undefined') {
            initGoogleSignIn();
        }
    });

    // ========================================
    // INITIALIZATION
    // ========================================

    /**
     * Initialize all authentication functionality
     */
    function init() {
        // Initialize WOW.js for animations if available
        if (typeof WOW !== 'undefined') {
            new WOW().init();
        }

        // Initialize all components
        initPasswordToggle();
        initLoginForm();
        initSignupForm();
        initGoogleLogin();

        // Initialize Google Sign-In
        if (typeof google !== 'undefined') {
            initGoogleSignIn();
        }
    }

    // Run initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
