class DOMUtils {
  constructor() {
    this.cache = {};
  }

  get(id) {
    if (!this.cache[id]) {
      this.cache[id] = document.getElementById(id);
    }
    return this.cache[id];
  }

  query(selector) {
    return document.querySelector(selector);
  }

  queryAll(selector) {
    return document.querySelectorAll(selector);
  }

  create(tagName, options = {}) {
    const element = document.createElement(tagName);
    
    if (options.className) {
      element.className = options.className;
    }
    
    if (options.textContent) {
      element.textContent = options.textContent;
    }
    
    if (options.innerHTML) {
      element.innerHTML = options.innerHTML;
    }
    
    if (options.dataset) {
      Object.keys(options.dataset).forEach(key => {
        element.dataset[key] = options.dataset[key];
      });
    }
    
    if (options.attributes) {
      Object.keys(options.attributes).forEach(key => {
        element.setAttribute(key, options.attributes[key]);
      });
    }
    
    if (options.style) {
      Object.keys(options.style).forEach(key => {
        element.style[key] = options.style[key];
      });
    }
    
    return element;
  }

  append(parent, child) {
    if (parent && child) {
      parent.appendChild(child);
    }
  }

  prepend(parent, child) {
    if (parent && child) {
      parent.prepend(child);
    }
  }

  remove(element) {
    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }

  empty(container) {
    if (container) {
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    }
  }

  show(element) {
    if (element) {
      element.style.display = '';
    }
  }

  hide(element) {
    if (element) {
      element.style.display = 'none';
    }
  }

  toggle(element, show) {
    if (element) {
      element.style.display = show ? '' : 'none';
    }
  }

  addClass(element, className) {
    if (element && className) {
      element.classList.add(className);
    }
  }

  removeClass(element, className) {
    if (element && className) {
      element.classList.remove(className);
    }
  }

  toggleClass(element, className) {
    if (element && className) {
      element.classList.toggle(className);
    }
  }

  hasClass(element, className) {
    return element && element.classList.contains(className);
  }

  setText(element, text) {
    if (element) {
      element.textContent = text;
    }
  }

  setHtml(element, html) {
    if (element) {
      element.innerHTML = html;
    }
  }

  setValue(element, value) {
    if (element) {
      element.value = value;
    }
  }

  getValue(element) {
    return element ? element.value : null;
  }

  on(element, event, handler, options = {}) {
    if (element && event && handler) {
      element.addEventListener(event, handler, options);
    }
  }

  off(element, event, handler, options = {}) {
    if (element && event && handler) {
      element.removeEventListener(event, handler, options);
    }
  }

  trigger(element, eventName) {
    if (element) {
      const event = new Event(eventName, { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    }
  }

  fadeIn(element, duration = 300) {
    if (!element) return;
    
    element.style.opacity = '0';
    element.style.display = '';
    
    let start = null;
    const animate = (timestamp) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      element.style.opacity = String(progress);
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    
    requestAnimationFrame(animate);
  }

  fadeOut(element, duration = 300, callback) {
    if (!element) return;
    
    element.style.opacity = '1';
    
    let start = null;
    const animate = (timestamp) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      element.style.opacity = String(1 - progress);
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        element.style.display = 'none';
        if (typeof callback === 'function') {
          callback();
        }
      }
    };
    
    requestAnimationFrame(animate);
  }

  debounce(func, wait) {
    let timeout = null;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  throttle(func, limit) {
    let inThrottle = false;
    return function executedFunction(...args) {
      if (!inThrottle) {
        func(...args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  clearCache() {
    this.cache = {};
  }

  invalidateCache(id) {
    if (id) {
      delete this.cache[id];
    } else {
      this.clearCache();
    }
  }
}

const dom = new DOMUtils();

module.exports = { DOMUtils, dom };
