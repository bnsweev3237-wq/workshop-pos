(function () {
  const $ = (id) => document.getElementById(id);
  const businessName = $('businessName');
  const slug = $('slug');
  const slugStatus = $('slugStatus');
  const slugDomain = $('slugDomain');
  const errorBox = $('signupError');
  const submitBtn = $('signupSubmit');

  slugDomain.textContent = '.' + window.location.host;

  let slugEditedByHand = false;
  slug.addEventListener('input', () => { slugEditedByHand = true; checkSlug(); });

  function slugify(s) {
    return s.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  businessName.addEventListener('input', () => {
    if (slugEditedByHand) return;
    slug.value = slugify(businessName.value);
    checkSlug();
  });

  let checkTimer = null;
  function checkSlug() {
    const value = slug.value.trim();
    clearTimeout(checkTimer);
    if (!value) { slugStatus.textContent = ''; slugStatus.className = 'slug-status'; return; }
    slugStatus.textContent = 'Checking…';
    slugStatus.className = 'slug-status';
    checkTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/platform/slug-available?slug=' + encodeURIComponent(value));
        const data = await res.json();
        if (data.available) {
          slugStatus.textContent = 'Available';
          slugStatus.className = 'slug-status ok';
        } else {
          slugStatus.textContent = data.message || 'Not available';
          slugStatus.className = 'slug-status bad';
        }
      } catch {
        slugStatus.textContent = '';
        slugStatus.className = 'slug-status';
      }
    }, 350);
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  submitBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    const body = {
      businessName: businessName.value.trim(),
      slug: slug.value.trim(),
      ownerName: $('ownerName').value.trim(),
      email: $('email').value.trim(),
      username: $('username').value.trim(),
      password: $('password').value,
    };
    if (!body.businessName || !body.slug || !body.email || !body.username || !body.password) {
      showError('Please fill in every field.');
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
      showError('Enter a valid email address.');
      return;
    }
    if (body.password.length < 8) {
      showError('Password must be at least 8 characters.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating your shop…';
    try {
      const res = await fetch('/api/platform/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showError(data.message || 'Could not create your shop. Please try a different address or try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create my shop';
        return;
      }
      $('signupFields').hidden = true;
      $('signupSubmit').hidden = true;
      $('signupSuccessMessage').textContent = `"${body.businessName}" is ready. We've sent a link to ${body.email} to activate it — click it to verify your email before you can sign in. Take a look at the guide below while you wait.`;
      $('continueToShopBtn').onclick = () => { window.location.href = data.loginUrl; };
      $('signupSuccess').hidden = false;
    } catch {
      showError('Could not reach the server. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create my shop';
    }
  });
})();
